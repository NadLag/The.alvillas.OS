import type {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {AccountingPeriodClosedError,AccountingPeriodPolicyError} from "../domain/accounting-period";
import {EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError} from "../domain/employee-compensation-run";
import {employeeCompensationCorrectionInput,employeeCompensationCorrectionRequestViewSchema} from "../domain/employee-compensation-correction";
import {employeeCompensationCorrectionWorkspaceInput,employeeCompensationCorrectionWorkspaceSchema} from "../domain/employee-compensation-correction-workspace";
import {EmployeeCompensationRecognitionRequestRepository} from "../infrastructure/employee-compensation-recognition-request-repository";
import {prepareEmployeeCompensationSettlement} from "./employee-compensation-settlement";
import {prepareEmployeeCompensationCorrection} from "./employee-compensation-correction";
import {employeeCompensationFinancialRequestView} from "./employee-compensation-recognition-requests";
import {getEmployeeCompensationClaimDetail} from "./employee-compensation-claim-workspace";
import {ExpensePolicyUnavailableError} from "./expense-submission-policy";
import type {FinanceActorContext} from "./finance-access";

/** Read original evidence and correction history under the same locks, scope and complete financial authority. */
export async function getEmployeeCompensationCorrectionWorkspace(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=employeeCompensationCorrectionWorkspaceInput.parse(raw);
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const prepared=await prepareEmployeeCompensationSettlement(ctx,input.id,input.claimId,tx,"view"),db:TenantTransactionRunner={$transaction:work=>work(tx)},original=await getEmployeeCompensationClaimDetail(ctx,{id:input.id,claimId:input.claimId,...input.after?{after:input.after}:{}},{db,requestId:deps.requestId});
  if(!original.recognition||original.recognition.id!==prepared.existing!.id)throw new EmployeeCompensationRunConflictError();
  const requests=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId),anchor=input.beforeRequest?await requests.find(input.beforeRequest):null;
  if(input.beforeRequest&&(!anchor||anchor.operation!=="REVERSE"||anchor.claimId!==input.claimId||anchor.requestedBy!==ctx.actorId||anchor.originalRecognitionId!==prepared.existing!.id))throw new EmployeeCompensationRunAccessError();
  const pending=await requests.pendingClaims([input.claimId],"REVERSE"),own=pending.find(row=>row.requestedBy===ctx.actorId),history=await requests.history(input.claimId,ctx.actorId,anchor?.id,"REVERSE"),outstanding=await prepared.payables.outstanding({claimId:input.claimId,personId:prepared.retained.personId,currency:prepared.retained.amount.currency}),correction=prepared.existing!.correction;
  let blocked:z.infer<typeof employeeCompensationCorrectionWorkspaceSchema>["blocked"]=correction?"already_corrected":pending.length?"request_pending":null,eligibilityRecheck:(()=>Promise<void>)|undefined;
  if(!blocked){
   try{const eligible=await prepareEmployeeCompensationCorrection(ctx,{id:input.id,claimId:input.claimId,recognitionId:prepared.existing!.id,idempotencyKey:crypto.randomUUID(),reason:"Review original employee claim correction eligibility"},tx);eligibilityRecheck=async()=>{await eligible.recheckCorrection(await eligible.finance.clock());};}
   catch(error){if(error instanceof EmployeeCompensationRunAccessError)blocked="posting_forbidden";
    else if(error instanceof AccountingPeriodClosedError)blocked="period_closed";
    else if(error instanceof ExpensePolicyUnavailableError||error instanceof AccountingPeriodPolicyError)blocked="configuration_unavailable";
    else if(error instanceof EmployeeCompensationRunConflictError)blocked=prepared.journals.some(journal=>!journal.reversesTransactionId&&prepared.receipts.has(journal.id)&&!journal.reversedByTransactions.length)?"active_payments":"source_changed";
    else throw error;}
  }
  const costIds=new Set(original.costs.map(cost=>cost.id)),result=employeeCompensationCorrectionWorkspaceSchema.parse({source:original.source,claim:original.claim,costs:original.costs,labels:original.labels,next:original.next,recognition:original.recognition,outstanding:outstanding.toJSON(),
   correction:correction?{id:correction.id,at:correction.createdAt.toISOString(),reason:correction.reason,journalCount:correction.lines.length,lines:correction.lines.filter(line=>costIds.has(line.costId)).map(line=>({costId:line.costId,originalTransactionId:line.originalTransactionId,reversalTransactionId:line.reversalTransactionId,postedAt:line.reversalTransaction.occurredAt.toISOString()}))}:null,
   canRequest:blocked===null,blocked,ownPending:own?employeeCompensationCorrectionRequestViewSchema.parse(employeeCompensationFinancialRequestView(own,true)):null,
   history:history.slice(0,10).map(row=>{const input=employeeCompensationCorrectionInput.parse(row.input),receipt=employeeCompensationCorrectionRequestViewSchema.parse(employeeCompensationFinancialRequestView(row,true));return{requestId:row.id,at:row.requestedAt.toISOString(),reason:input.reason,state:receipt.state,failureCode:receipt.failureCode,correctionId:receipt.correctionId};}),nextRequest:history.length>10?history[9].id:null});
  await prepared.recheckSettlement(await prepared.finance.clock());await eligibilityRecheck?.();return result;
 },{timeout:120000});
}
