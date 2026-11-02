import {createHash} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {employeeCompensationFinancialSourceFacts} from "@/platform/authz/employee-compensation-resource";
import {EmployeeCompensationCorrectionRepository} from "../infrastructure/employee-compensation-correction-repository";
import {employeeCompensationCorrectionInput,employeeCompensationCorrectionViewSchema} from "../domain/employee-compensation-correction";
import {EmployeeCompensationRunConflictError} from "../domain/employee-compensation-run";
import {prepareEmployeeCompensationSettlement} from "./employee-compensation-settlement";
import type {FinanceActorContext,recheckFinanceAuthorization} from "./finance-access";

type Input=z.infer<typeof employeeCompensationCorrectionInput>;
type Check=Parameters<typeof recheckFinanceAuthorization>[3][number];
export const employeeCompensationCorrectionFingerprint=(actorId:string,input:Input)=>createHash("sha256").update(JSON.stringify({actorId,...input})).digest("hex");

/** Admit a correction only against the full original approved claim and actual payment history. */
export async function prepareEmployeeCompensationCorrection(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction){
 const input=employeeCompensationCorrectionInput.parse(raw),fingerprint=employeeCompensationCorrectionFingerprint(ctx.actorId,input),corrections=new EmployeeCompensationCorrectionRepository(tx,ctx.organizationId);
 await corrections.lockKey(input.idempotencyKey);
 const source=await prepareEmployeeCompensationSettlement(ctx,input.id,input.claimId,tx,"void"),recognition=source.existing!;
 if(recognition.id!==input.recognitionId)throw new EmployeeCompensationRunConflictError();
 const existing=await corrections.byClaim(input.claimId),sameKey=await corrections.byKey(input.idempotencyKey),now=await source.finance.clock();
 if((existing||sameKey)&&(!existing||sameKey?.id!==existing.id||existing.createdBy!==ctx.actorId||existing.requestFingerprint!==fingerprint||existing.reason!==input.reason))throw new EmployeeCompensationRunConflictError();
 const originals=source.retained.costs.map(cost=>{const link=recognition.lines.find(line=>line.costId===cost.id),journal=source.journals.find(row=>row.id===link?.transactionId);if(!link||!journal||journal.reversesTransactionId)throw new EmployeeCompensationRunConflictError();return{cost,link,journal};});
 const checks:Check[]=originals.flatMap(({cost})=>{
  const actual=source.row.costs.find(row=>row.id===cost.id)!;
  const {financial}=employeeCompensationFinancialSourceFacts(ctx.organizationId,ctx.actorId,{...actual,taskId:actual.runLine.taskId},now),organizationOnly=!cost.propertyId;
  return[{action:"view",resource:financial,organizationOnly},{action:"create",resource:financial,organizationOnly}];
 });
 const recheckCorrection=async(at:Date)=>source.recheckSettlement(at,checks);
 await recheckCorrection(now);
 if(existing){
  if(existing.recognitionId!==recognition.id||existing.lines.length!==originals.length||originals.some(({cost,link,journal})=>{
   const retained=existing.lines.find(line=>line.costId===cost.id);
   return !retained||retained.recognitionLineId!==link.id||retained.originalTransactionId!==journal.id||journal.reversedByTransactions.length!==1||journal.reversedByTransactions[0].id!==retained.reversalTransactionId;
  }))throw new EmployeeCompensationRunConflictError();
 }else{
  if(originals.some(({journal})=>journal.reversedByTransactions.length)||source.journals.some(journal=>!journal.reversesTransactionId&&source.receipts.has(journal.id)&&!journal.reversedByTransactions.length))throw new EmployeeCompensationRunConflictError();
  const outstanding=await source.payables.outstanding({claimId:input.claimId,personId:source.retained.personId,currency:source.retained.amount.currency});
  if(!outstanding.amount.eq(source.retained.amount.amount))throw new EmployeeCompensationRunConflictError();
  await source.periods.assertPostingOpen(now);
 }
 return{...source,input,fingerprint,corrections,correction:existing,originals,now,recheckCorrection};
}

/** Append exact opposite journals atomically; immutable earnings, approvals and payment receipts remain intact. */
export async function correctEmployeeCompensationClaim(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const source=await prepareEmployeeCompensationCorrection(ctx,raw,tx),{input,originals,now}=source;
  if(source.correction){await source.recheckCorrection(await source.finance.clock());return employeeCompensationCorrectionViewSchema.parse({id:input.id,claimId:input.claimId,recognitionId:input.recognitionId,correctionId:source.correction.id,originalTransactionIds:originals.map(({journal})=>journal.id),reversalTransactionIds:originals.map(({cost})=>source.correction!.lines.find(line=>line.costId===cost.id)!.reversalTransactionId),idempotent:true});}
  const correction=await source.corrections.create({submissionId:input.id,claimId:input.claimId,recognitionId:input.recognitionId,idempotencyKey:input.idempotencyKey,requestFingerprint:source.fingerprint,reason:input.reason,createdBy:ctx.actorId});
  const reversals=await source.finance.createFinancialTransactions(originals.map(({journal})=>({reference:journal.reference+":VOID",description:input.reason,occurredAt:now,idempotencyKey:journal.idempotencyKey+":void",reversesTransactionId:journal.id,createdBy:ctx.actorId,
   postings:journal.postings.map(posting=>({ledgerAccountId:posting.ledgerAccountId,side:posting.side==="DEBIT"?"CREDIT" as const:"DEBIT" as const,amount:Money.of(posting.amount.toString(),posting.currency),bucket:z.string().parse(posting.bucket),dimensions:z.record(z.string(),z.unknown()).parse(posting.dimensions)}))})),at=>source.recheckCorrection(at).then(()=>undefined));
  await source.corrections.lines(originals.map(({cost,link,journal},index)=>({correctionId:correction.id,costId:cost.id,recognitionLineId:link.id,originalTransactionId:journal.id,reversalTransactionId:reversals[index].id})));
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.corrected",resourceType:"employee_compensation_claim",resourceId:input.claimId,after:{correctionId:correction.id,submissionId:input.id,runId:source.row.runId,recognitionId:input.recognitionId,claimId:input.claimId,personId:source.retained.personId,originalTransactionIds:originals.map(({journal})=>journal.id),reversalTransactionIds:reversals.map(row=>row.id),amount:source.retained.amount.toJSON()},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await source.recognitions.flushGuards();await source.recheckCorrection(await source.finance.clock());
  const outstanding=await source.payables.outstanding({claimId:input.claimId,personId:source.retained.personId,currency:source.retained.amount.currency});if(!outstanding.amount.isZero())throw new EmployeeCompensationRunConflictError();
  return employeeCompensationCorrectionViewSchema.parse({id:input.id,claimId:input.claimId,recognitionId:input.recognitionId,correctionId:correction.id,originalTransactionIds:originals.map(({journal})=>journal.id),reversalTransactionIds:reversals.map(row=>row.id),idempotent:false});
 },{timeout:120000});
}
