import type {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {AccountingPeriodClosedError,AccountingPeriodPolicyError} from "../domain/accounting-period";
import {EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError} from "../domain/employee-compensation-run";
import {employeeCompensationCorrectionInput,employeeCompensationCorrectionRequestViewSchema} from "../domain/employee-compensation-correction";
import {employeeCompensationCorrectionWorkspaceInput,employeeCompensationCorrectionWorkspaceSchema} from "../domain/employee-compensation-correction-workspace";
import {EmployeeCompensationRecognitionRequestRepository} from "../infrastructure/employee-compensation-recognition-request-repository";
import {EmployeeCompensationRecognitionRepository} from "../infrastructure/employee-compensation-recognition-repository";
import {prepareEmployeeCompensationSettlement} from "./employee-compensation-settlement";
import {prepareEmployeeCompensationCorrection} from "./employee-compensation-correction";
import {employeeCompensationFinancialRequestView} from "./employee-compensation-recognition-requests";
import {employeeCompensationClaimEvidence} from "./employee-compensation-claim-workspace";
import {ExpensePolicyUnavailableError} from "./expense-submission-policy";
import type {FinanceActorContext} from "./finance-access";

/** One locked original source supplies settlement authority, evidence and correction eligibility. */
export async function getEmployeeCompensationCorrectionWorkspace(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=employeeCompensationCorrectionWorkspaceInput.parse(raw);
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const recognition=await new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId).byClaim(input.claimId);
  let prepared:Awaited<ReturnType<typeof prepareEmployeeCompensationSettlement>>,eligibilityRecheck:(()=>Promise<void>)|undefined,hint:z.infer<typeof employeeCompensationCorrectionWorkspaceSchema>["blocked"]=null;
  if(recognition&&!recognition.correction){
   try{const eligible=await prepareEmployeeCompensationCorrection(ctx,{id:input.id,claimId:input.claimId,recognitionId:recognition.id,idempotencyKey:crypto.randomUUID(),reason:"Review original employee claim correction eligibility"},tx);prepared=eligible;eligibilityRecheck=async()=>{await eligible.recheckCorrection(await eligible.finance.clock());};}
   catch(error){
    prepared=await prepareEmployeeCompensationSettlement(ctx,input.id,input.claimId,tx,"view");
    if(error instanceof EmployeeCompensationRunAccessError)hint="posting_forbidden";
    else if(error instanceof AccountingPeriodClosedError)hint="period_closed";
    else if(error instanceof ExpensePolicyUnavailableError||error instanceof AccountingPeriodPolicyError)hint="configuration_unavailable";
    else if(error instanceof EmployeeCompensationRunConflictError)hint=prepared.journals.some(journal=>!journal.reversesTransactionId&&prepared.receipts.has(journal.id)&&!journal.reversedByTransactions.length)?"active_payments":"source_changed";
    else throw error;
   }
  }else prepared=await prepareEmployeeCompensationSettlement(ctx,input.id,input.claimId,tx,"view");
  const original=await employeeCompensationClaimEvidence(ctx,input,prepared.row,prepared.existing!,tx,deps);
  if(!original.recognition||original.recognition.id!==prepared.existing!.id)throw new EmployeeCompensationRunConflictError();
  const requests=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId),anchor=input.beforeRequest?await requests.find(input.beforeRequest):null;
  if(input.beforeRequest&&(!anchor||anchor.operation!=="REVERSE"||anchor.claimId!==input.claimId||anchor.requestedBy!==ctx.actorId||anchor.originalRecognitionId!==prepared.existing!.id))throw new EmployeeCompensationRunAccessError();
  const pending=await requests.pendingClaims([input.claimId],"REVERSE"),own=pending.find(row=>row.requestedBy===ctx.actorId),history=await requests.history(input.claimId,ctx.actorId,anchor?.id,"REVERSE"),outstanding=await prepared.payables.outstanding({claimId:input.claimId,personId:prepared.retained.personId,currency:prepared.retained.amount.currency}),correction=prepared.existing!.correction,blocked=correction?"already_corrected" as const:pending.length?"request_pending" as const:hint;
  const costIds=new Set(original.costs.map(cost=>cost.id)),result=employeeCompensationCorrectionWorkspaceSchema.parse({source:original.source,claim:original.claim,costs:original.costs,labels:original.labels,next:original.next,recognition:original.recognition,outstanding:outstanding.toJSON(),
   correction:correction?{id:correction.id,at:correction.createdAt.toISOString(),reason:correction.reason,journalCount:correction.lines.length,lines:correction.lines.filter(line=>costIds.has(line.costId)).map(line=>({costId:line.costId,originalTransactionId:line.originalTransactionId,reversalTransactionId:line.reversalTransactionId,postedAt:line.reversalTransaction.occurredAt.toISOString()}))}:null,
   canRequest:blocked===null,blocked,ownPending:own?employeeCompensationCorrectionRequestViewSchema.parse(employeeCompensationFinancialRequestView(own,true)):null,
   history:history.slice(0,10).map(row=>{const input=employeeCompensationCorrectionInput.parse(row.input),receipt=employeeCompensationCorrectionRequestViewSchema.parse(employeeCompensationFinancialRequestView(row,true));return{requestId:row.id,at:row.requestedAt.toISOString(),reason:input.reason,state:receipt.state,failureCode:receipt.failureCode,correctionId:receipt.correctionId};}),nextRequest:history.length>10?history[9].id:null});
  if(eligibilityRecheck)await eligibilityRecheck();else await prepared.recheckSettlement(await prepared.finance.clock());return result;
 },{timeout:120000});
}
