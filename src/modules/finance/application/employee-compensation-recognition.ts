import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import { currentTimezoneData } from "@/platform/time/timezone-data";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationClaimRepository } from "../infrastructure/employee-compensation-claim-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationRecognitionRepository } from "../infrastructure/employee-compensation-recognition-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { AccountingPeriodAdjustmentRepository } from "../infrastructure/accounting-period-adjustment-repository";
import { employeeCompensationRecognitionCosts,employeeCompensationRecognitionInput } from "../domain/employee-compensation-recognition";
import { employeeClaimPostings } from "../domain/employee-payable";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { employeeCompensationCostResource } from "../domain/employee-compensation-cost-resource";
import { recheckEmployeeSubmission,employeeCompensationSubmissionState,employeeCompensationSubmissionFinancialChecks } from "./employee-compensation-submission";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import type { recheckFinanceAuthorization,FinanceActorContext } from "./finance-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";

export { employeeCompensationRecognitionInput } from "../domain/employee-compensation-recognition";
export function employeeCompensationRecognitionFingerprint(actorId:string,input:z.infer<typeof employeeCompensationRecognitionInput>){return createHash("sha256").update(JSON.stringify({actorId,...input})).digest("hex");}
type Intent={kind:"recognize";input:z.infer<typeof employeeCompensationRecognitionInput>;fingerprint:string}|{kind:"inspect";id:string;claimId:string};
async function prepare(ctx:FinanceActorContext,intent:Intent,tx:TenantTransaction){
  const input=intent.kind==="recognize"?intent.input:undefined,id=input?.id??(intent as Extract<Intent,{kind:"inspect"}>).id,claimId=input?.claimId??(intent as Extract<Intent,{kind:"inspect"}>).claimId;
  const claims=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),
    recognitions=new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId),periods=new AccountingPeriodRepository(tx,ctx.organizationId);
  const initial=await claims.find(id);if(!initial)throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,initial,tx);
  if(input)await recognitions.lockKey(input.idempotencyKey);await runs.lock(initial.runId);await claims.lock(id);
  const row=await claims.find(id);if(!row)throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,row,tx);
  if(row.withdrawal||row.run.cancellation||employeeCompensationSubmissionState(row)!=="APPROVED"||row.approval?.financialStages.some(stage=>stage.state!=="APPROVED"))throw new EmployeeCompensationRunConflictError();
  const retained=employeeCompensationRecognitionCosts({organizationId:ctx.organizationId,id:row.id,runId:row.runId,costOn:row.costOn.toISOString().slice(0,10),currency:row.run.currency,emergency:row.emergency,claims:row.claims,
    runLines:row.run.lines.map(line=>({...line,recordedCompletionAt:line.recordedCompletionAt.toISOString(),amount:line.amount.toString()})),costs:row.costs.map(cost=>({...cost,amount:cost.amount.toString()}))},claimId,row.snapshot);
  const person=await recognitions.person(retained.personId);if(!person)throw new EmployeeCompensationRunAccessError();
  if(!currentTimezoneData())throw new ExpensePolicyUnavailableError("Current IANA calendar data is unavailable");
  for(const[timezone,instant]of new Map(retained.costs.map(cost=>[cost.timezone,cost.sourceOccurredAt]))){if(!await finance.financialCalendarMatches(row.costOn.toISOString().slice(0,10),timezone,instant))throw new ExpensePolicyUnavailableError("Financial database calendar data differs from the current IANA source");}
  const existing=await recognitions.byClaim(claimId),sameKey=input?await recognitions.byKey(input.idempotencyKey):null,current=await finance.clock(),postAt=new Map<string,Date>(),
    adjustments=new Map<string,NonNullable<Awaited<ReturnType<AccountingPeriodRepository["postingPeriod"]>>>>();
  if(existing)for(const line of existing.lines)postAt.set(line.costId,line.transaction.occurredAt);
  else for(const cost of retained.costs){
    if(input?.currentPeriod&&!await periods.postingOpen(cost.sourceOccurredAt)){const closed=await periods.postingPeriod(cost.sourceOccurredAt);if(!closed?.events[0])throw new EmployeeCompensationRunConflictError();adjustments.set(cost.id,closed);postAt.set(cost.id,current);}
    else postAt.set(cost.id,cost.sourceOccurredAt);
  }
  const recheck=async()=>{
    const actual=await claims.find(id),beneficiary=await recognitions.person(retained.personId);
    if(!actual||JSON.stringify(actual)!==JSON.stringify(row)||!beneficiary)throw new EmployeeCompensationRunAccessError();
    const facts=employeeCompensationRunFacts(ctx.organizationId,actual.run),checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[...employeeCompensationSubmissionFinancialChecks(ctx.organizationId,actual,facts.total)];
    for(const cost of retained.costs){
      const source=actual.costs.find(line=>line.id===cost.id),postingAt=postAt.get(cost.id);if(!source||!postingAt)throw new EmployeeCompensationRunAccessError();
      const {financial}=employeeCompensationFinancialSourceFacts(ctx.organizationId,row.run.createdBy,{...source,taskId:source.runLine.taskId},cost.sourceOccurredAt),link=existing?.lines.find(line=>line.costId===cost.id);
      checks.push({action:"view",resource:employeeCompensationCostResource(ctx.organizationId,actual,source,{ownerId:null,amount:source.amount,status:"APPROVED"},source.property,cost.sourceOccurredAt)},
        {action:"view",resource:{...financial,id:link?.transactionId,financialRecordId:link?.transactionId}});
      if(input)checks.push({action:"create",resource:{...financial,occurredAt:postingAt}});
      if(input&&(adjustments.has(cost.id)||link?.periodAdjustment))checks.push({action:"override",resource:financial});
      if(link&&postingAt.getTime()!==cost.sourceOccurredAt.getTime())checks.push({action:"view",resource:{...financial,id:link.transactionId,financialRecordId:link.transactionId,occurredAt:postingAt}});
    }
    await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,input?"pay":"view",checks);
  };
  await recheck();
  if(input&&(existing||sameKey)&&(!existing||sameKey?.id!==existing.id||existing.requestFingerprint!==(intent as Extract<Intent,{kind:"recognize"}>).fingerprint||existing.createdBy!==ctx.actorId))throw new EmployeeCompensationRunConflictError();
  if(input?.currentPeriod&&!existing&&!adjustments.size)throw new EmployeeCompensationRunConflictError();
  return{claims,finance,recognitions,periods,row,retained,existing,postAt,adjustments,recheck};
}
export async function prepareEmployeeCompensationRecognition(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction){
  const input=employeeCompensationRecognitionInput.parse(raw),fingerprint=employeeCompensationRecognitionFingerprint(ctx.actorId,input);return{...await prepare(ctx,{kind:"recognize",input,fingerprint},tx),input,fingerprint};
}
export function inspectEmployeeCompensationRecognition(ctx:FinanceActorContext,id:string,claimId:string,tx:TenantTransaction){return prepare(ctx,{kind:"inspect",id:z.uuid().parse(id),claimId:z.uuid().parse(claimId)},tx);}

/** Earned recognition changes ownership claims; physical money moves only through a later settlement. */
export async function recognizeEmployeeCompensation(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{input,fingerprint,finance,claims,recognitions,row,retained,existing,postAt,adjustments,recheck}=await prepareEmployeeCompensationRecognition(ctx,raw,tx);
    if(existing)return{id:row.id,claimId:input.claimId,recognitionId:existing.id,transactionIds:retained.costs.map(cost=>{const link=existing.lines.find(line=>line.costId===cost.id);if(!link)throw new EmployeeCompensationRunConflictError();return link.transactionId;}),idempotent:true};
    const currency=await claims.currency(row.run.currency);if(!currency||retained.costs.some(cost=>cost.amount.amount.decimalPlaces()>currency.minorUnit))throw new ExpensePolicyUnavailableError("Employee currency precision is unavailable");
    const accounts=new Map<string,string>();
    for(const[code,accountType,normalSide]of[["EMPLOYEE_PAYABLE","CLAIM_OWNERSHIP","CREDIT"],["OWNER_PAYABLE","CLAIM_OWNERSHIP","CREDIT"],["ALVILLAS_EXPENSE","ALVILLAS_OWN","DEBIT"],["GUEST_RECEIVABLE","CLAIM_OWNERSHIP","DEBIT"]]as const){
      if(code!=="EMPLOYEE_PAYABLE"&&!retained.costs.some(cost=>(code==="OWNER_PAYABLE"?cost.allocation.ownerAmount:code==="ALVILLAS_EXPENSE"?cost.allocation.alvillasAmount:cost.allocation.guestAmount).amount.gt(0)))continue;
      const account=await finance.ensureLedgerAccount({code,name:code,accountType,normalSide});if(account.archivedAt||account.accountType!==accountType||account.normalSide!==normalSide)throw new ExpensePolicyUnavailableError("Employee ledger account is unavailable");accounts.set(code,account.id);
    }
    const recognition=await recognitions.create({submissionId:row.id,claimId:input.claimId,currentPeriod:input.currentPeriod,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,reason:input.reason,createdBy:ctx.actorId});
    const journals=await finance.createFinancialTransactions(retained.costs.map(cost=>({reference:`EMPLOYEE-COMPENSATION:${input.claimId}:${cost.id}`,description:cost.note,occurredAt:postAt.get(cost.id)!,
      idempotencyKey:`employee-compensation:${row.id}:${cost.id}:recognized`,createdBy:ctx.actorId,postings:employeeClaimPostings({claimId:input.claimId,personId:retained.personId,runId:row.runId,liabilityAccountId:accounts.get("EMPLOYEE_PAYABLE")!,amount:cost.amount,
        lines:[{...cost,ownerAccounts:new Map(cost.owners.map(owner=>[owner.ownerId,accounts.get("OWNER_PAYABLE")??""])),companyExpenseAccountId:accounts.get("ALVILLAS_EXPENSE")??"",guestReceivableAccountId:accounts.get("GUEST_RECEIVABLE")??""}]})})),recheck),
      transactionIds=journals.map(journal=>journal.id),links=await recognitions.lines(retained.costs.map((cost,index)=>({recognitionId:recognition.id,costId:cost.id,transactionId:journals[index].id,sourceOccurredAt:cost.sourceOccurredAt}))),requestId=deps.requestId??crypto.randomUUID();
    for(const[index,cost]of retained.costs.entries()){
      const closed=adjustments.get(cost.id);if(!closed)continue;const link=links.find(line=>line.costId===cost.id);if(!link)throw new EmployeeCompensationRunConflictError();const journal=journals[index];
      const adjustment=await new AccountingPeriodAdjustmentRepository(tx,ctx.organizationId).create({employeeRecognitionLineId:link.id,transactionId:journal.id,periodId:closed.id,periodEventId:closed.events[0].id,sourceOccurredAt:cost.sourceOccurredAt,reason:input.reason,createdBy:ctx.actorId});
      await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.period.adjustment_posted",resourceType:"financial_transaction",resourceId:journal.id,propertyScopeId:cost.propertyId,
        after:{adjustmentId:adjustment.id,employeeRecognitionLineId:link.id,claimId:input.claimId,submissionId:row.id,transactionId:journal.id,sourcePeriodId:closed.id,sourcePeriodEventId:closed.events[0].id,sourceOccurredAt:cost.sourceOccurredAt.toISOString(),postedAt:journal.occurredAt.toISOString()},reason:input.reason,requestId,occurredAt:await finance.clock()});
    }
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.recognized",resourceType:"employee_compensation_claim",resourceId:input.claimId,
      after:{recognitionId:recognition.id,submissionId:row.id,runId:row.runId,claimId:input.claimId,personId:retained.personId,transactionIds,amount:retained.amount.toJSON(),postingDateMode:input.currentPeriod?"ADJUST_CLOSED_SOURCES":"SOURCE_DATES"},reason:input.reason,requestId,occurredAt:await finance.clock()});
    await recognitions.flushGuards();await recheck();return{id:row.id,claimId:input.claimId,recognitionId:recognition.id,transactionIds,idempotent:false};
  },{timeout:120000});
}
