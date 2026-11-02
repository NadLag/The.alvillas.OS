import type { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import { employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import { EmployeeCompensationClaimRepository,type EmployeeSubmissionRecord } from "../infrastructure/employee-compensation-claim-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationRecognitionRepository } from "../infrastructure/employee-compensation-recognition-repository";
import { EmployeeCompensationRecognitionRequestRepository } from "../infrastructure/employee-compensation-recognition-request-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { employeeCompensationClaimWorkspaceInput,employeeCompensationClaimWorkspaceSchema,employeeCompensationClaimDetailInput,employeeCompensationClaimDetailSchema } from "../domain/employee-compensation-claim-workspace";
import { employeeCompensationRecognitionInput,employeeCompensationRecognitionRequestViewSchema } from "../domain/employee-compensation-recognition-command";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { employeeCompensationCostResource } from "../domain/employee-compensation-cost-resource";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { readEmployeeCompensationSubmissionInTransaction,recheckEmployeeSubmission,employeeCompensationSubmissionState } from "./employee-compensation-submission";
import { inspectEmployeeCompensationRecognition,prepareEmployeeCompensationRecognition } from "./employee-compensation-recognition";
import { employeeCompensationSourceLabels } from "./employee-compensation-source-labels";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Receipts=Awaited<ReturnType<EmployeeCompensationRecognitionRepository["workspaceForSubmission"]>>;
type Pending=Awaited<ReturnType<EmployeeCompensationRecognitionRequestRepository["pendingClaims"]>>;
type Checks=Parameters<typeof recheckFinanceAuthorization>[3][number][];
const sourceView=(model:Awaited<ReturnType<typeof readEmployeeCompensationSubmissionInTransaction>>["model"])=>({id:model.id,runId:model.runId,purpose:model.purpose,state:model.state,costOn:model.costOn,total:model.total});
function claimAmount(row:EmployeeSubmissionRecord,claimId:string){let amount=Money.zero(row.run.currency),count=0;for(const cost of row.costs)if(cost.claimId===claimId){amount=amount.add(Money.of(cost.amount.toString(),cost.currency));count++;}if(!count||!amount.amount.gt(0))throw new EmployeeCompensationRunAccessError();return{amount:amount.toJSON(),costCount:count};}

/** The list reports original source amounts; opening a claim additionally checks its actual expense and journal sources. */
function claimChecks(organizationId:string,row:EmployeeSubmissionRecord,claimId:string,receipts:Receipts):Checks{
  const starts=new Map<string,Date>(),links=new Map(receipts.find(receipt=>receipt.claimId===claimId)?.lines.map(line=>[line.costId,line])??[]),checks:Checks=[];
  const status=row.withdrawal?"CANCELLED":employeeCompensationSubmissionState(row);
  for(const cost of row.costs){if(cost.claimId!==claimId)continue;let at=starts.get(cost.timezone);if(!at){at=calendarDateStart(row.costOn.toISOString().slice(0,10),cost.timezone);starts.set(cost.timezone,at);}
    checks.push({action:"view",resource:employeeCompensationCostResource(organizationId,row,cost,{ownerId:null,amount:cost.amount,status},cost.property,at)});
    const link=links.get(cost.id);if(link){const{financial}=employeeCompensationFinancialSourceFacts(organizationId,row.run.createdBy,{...cost,taskId:cost.runLine.taskId},at);
      checks.push({action:"view",resource:{...financial,id:link.transactionId,financialRecordId:link.transactionId,occurredAt:link.transaction.occurredAt}});}
  }return checks;
}
async function labels(ctx:FinanceActorContext,row:EmployeeSubmissionRecord,lineIds:readonly string[],tx:TenantTransaction){
  const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),rows=await runs.displayLines(row.runId,lineIds),evidence=rows.flatMap(value=>value.completionEvent?[employeeCompletedWorkEvidence(value.completionEvent)]:[]),validators=await runs.people(evidence.flatMap(event=>event.validated_by_person_id?[event.validated_by_person_id]:[]));
  if(rows.length!==new Set(lineIds).size)throw new EmployeeCompensationRunAccessError();return employeeCompensationSourceLabels(ctx,tx,rows,validators);
}
async function finalSource(ctx:FinanceActorContext,row:EmployeeSubmissionRecord,receipts:Receipts,pending:Pending,claimIds:readonly string[],checks:Checks,tx:TenantTransaction){
  const actual=await new EmployeeCompensationClaimRepository(tx,ctx.organizationId).find(row.id),currentReceipts=await new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId).workspaceForSubmission(row.id),currentPending=await new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId).pendingClaims(claimIds);
  if(JSON.stringify(actual)!==JSON.stringify(row))throw new EmployeeCompensationRunAccessError();
  if(JSON.stringify(currentReceipts)!==JSON.stringify(receipts)||JSON.stringify(currentPending)!==JSON.stringify(pending))throw new EmployeeCompensationRunConflictError();
  await recheckEmployeeSubmission(ctx,row,tx);await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeCompensationRunAccessError());
}

export async function getEmployeeCompensationClaimWorkspace(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationClaimWorkspaceInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{model,record}=await readEmployeeCompensationSubmissionInTransaction(ctx,{id:input.id},tx,deps),all=[...record.claims].sort((a,b)=>a.id.localeCompare(b.id)),boundary=input.after?all.findIndex(claim=>claim.id===input.after):-1;
    if(input.after&&boundary<0)throw new EmployeeCompensationRunAccessError();const page=all.slice(boundary+1,boundary+12),visible=page.slice(0,10),claimIds=visible.map(claim=>claim.id),representatives=visible.map(claim=>{const cost=record.costs.find(cost=>cost.claimId===claim.id);if(!cost)throw new EmployeeCompensationRunAccessError();return cost;});
    const receipts=await new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId).workspaceForSubmission(record.id),pending=await new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId).pendingClaims(claimIds),metadata=await labels(ctx,record,representatives.map(cost=>cost.runLineId),tx),byLine=new Map(metadata.labels.map(label=>[label.lineId,label])),now=await new FinanceRepository(tx,ctx.organizationId).clock(),checks:Checks=[...metadata.checks];
    const claims=visible.map((claim,index)=>{const access=claimChecks(ctx.organizationId,record,claim.id,receipts),canOpen=access.every(check=>[ctx.authContext,metadata.current].every(auth=>authorize(auth,check.action,check.resource,now)));if(canOpen)checks.push(...access);
      return{id:claim.id,personId:claim.personId,personName:byLine.get(representatives[index].runLineId)?.personName??null,...claimAmount(record,claim.id),recognized:receipts.some(receipt=>receipt.claimId===claim.id),pending:pending.some(request=>request.claimId===claim.id),canOpen};});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.claims_listed",resourceType:"employee_compensation_submission",resourceId:record.id,after:{claimIds},reason:"Viewed the authorized original beneficiary claims",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await new FinanceRepository(tx,ctx.organizationId).clock()});
    await finalSource(ctx,record,receipts,pending,claimIds,checks,tx);return employeeCompensationClaimWorkspaceSchema.parse({source:sourceView(model),claims,claimCount:all.length,next:page.length>10?visible[9].id:null});
  },{timeout:120000});
}

export async function getEmployeeCompensationClaimDetail(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationClaimDetailInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{model,record}=await readEmployeeCompensationSubmissionInTransaction(ctx,{id:input.id,after:input.after},tx,deps,{claimId:input.claimId}),claim=record.claims.find(claim=>claim.id===input.claimId);if(!claim)throw new EmployeeCompensationRunAccessError();
    const finance=new FinanceRepository(tx,ctx.organizationId),requests=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId),receipts=await new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId).workspaceForSubmission(record.id),receipt=receipts.find(value=>value.claimId===claim.id),pending=await requests.pendingClaims([claim.id]),checks=claimChecks(ctx.organizationId,record,claim.id,receipts);
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
    const anchor=input.beforeRequest?await requests.find(input.beforeRequest):null;if(input.beforeRequest&&(!anchor||anchor.claimId!==claim.id||anchor.requestedBy!==ctx.actorId||anchor.operation!=="RECOGNIZE"))throw new EmployeeCompensationRunAccessError();
    const history=await requests.history(claim.id,ctx.actorId,anchor?.id),metadata=await labels(ctx,record,model.costs.map(cost=>cost.runLineId),tx),ownPending=pending.find(request=>request.requestedBy===ctx.actorId),amount=claimAmount(record,claim.id);
    let eligibilityRecheck:(()=>Promise<void>)|undefined;
    let currentPeriod=false,canRequest=false,blocked:z.infer<typeof employeeCompensationClaimDetailSchema>["blocked"]=record.withdrawal?"withdrawn":record.run.cancellation?"run_cancelled":model.state==="PENDING_APPROVAL"?"pending_approval":model.state==="REJECTED"?"rejected":receipt?"already_recognized":pending.length?"request_pending":null;
    if(!blocked){
      const inspection=await inspectEmployeeCompensationRecognition(ctx,record.id,claim.id,tx),periods=new AccountingPeriodRepository(tx,ctx.organizationId),instants=new Map(inspection.retained.costs.map(cost=>[cost.sourceOccurredAt.toISOString(),cost.sourceOccurredAt]));
      for(const instant of instants.values())if(!await periods.postingOpen(instant))currentPeriod=true;
      try{const prepared=await prepareEmployeeCompensationRecognition(ctx,{id:record.id,claimId:claim.id,idempotencyKey:crypto.randomUUID(),reason:"Inspect current authority for this original employee claim",currentPeriod},tx);canRequest=!currentPeriod||await periods.postingOpen(await finance.clock());if(canRequest)eligibilityRecheck=prepared.recheck;else blocked="period_closed";}
      catch(error){if(error instanceof EmployeeCompensationRunAccessError)blocked="posting_forbidden";else if(error instanceof EmployeeCompensationRunConflictError)blocked="period_closed";else throw error;}
      await inspection.recheck();
    }
    const pageIds=new Set(model.costs.map(cost=>cost.id)),byCost=new Map(record.costs.map(cost=>[cost.id,cost]));
    const result={source:sourceView(model),claim:{id:claim.id,personId:claim.personId,personName:metadata.labels[0]?.personName??null,...amount,recognized:Boolean(receipt),pending:Boolean(pending.length),canOpen:true},
      costs:model.costs.map(cost=>{const actual=byCost.get(cost.id)!;return{...cost,recordedCompletionAt:actual.runLine.recordedCompletionAt.toISOString(),timezone:actual.timezone};}),labels:metadata.labels,next:model.nextCursor,
      recognition:receipt?{id:receipt.id,at:receipt.createdAt.toISOString(),reason:receipt.reason,journalCount:receipt.lines.length,lines:receipt.lines.filter(line=>pageIds.has(line.costId)).map(line=>({costId:line.costId,transactionId:line.transactionId,sourceOccurredAt:line.sourceOccurredAt.toISOString(),postedAt:line.transaction.occurredAt.toISOString()}))}:null,
      canRequest,currentPeriod,blocked,ownPending:ownPending?employeeCompensationRecognitionRequestViewSchema.parse({requestId:ownPending.id,submissionId:record.id,claimId:claim.id,state:"PENDING",recognitionId:null,failureCode:null,idempotent:true}):null,
      history:history.slice(0,10).map(request=>({requestId:request.id,at:request.requestedAt.toISOString(),reason:employeeCompensationRecognitionInput.parse(request.input).reason,state:request.outcome?.state??"PENDING",failureCode:request.outcome?.failureCode??null})),nextRequest:history.length>10?history[9].id:null};
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.claim_viewed",resourceType:"employee_compensation_claim",resourceId:claim.id,after:{claimId:claim.id,costIds:model.costs.map(cost=>cost.id)},reason:"Viewed authorized original employee claim and recognition history",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    await finalSource(ctx,record,receipts,pending,[claim.id],[...checks,...metadata.checks],tx);await eligibilityRecheck?.();return employeeCompensationClaimDetailSchema.parse(result);
  },{timeout:120000});
}
