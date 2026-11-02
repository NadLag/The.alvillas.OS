import {prepareEmployeePercentageRunSources,retainEmployeePercentageRunSources} from "./employee-percentage-run-source";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {employeePercentageRunCreateInput} from "../domain/employee-percentage-run";
import {EmployeeCompensationRunConflictError} from "../domain/employee-compensation-run";
import {EmployeeCompensationRunRepository} from "../infrastructure/employee-compensation-run-repository";
import {EmployeePercentageSourceRepository} from "../infrastructure/employee-percentage-source-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {employeeCompensationRunFacts,recheckEmployeeCompensationRun} from "./employee-compensation-run-access";
import {employeeCompensationRunModel,persistEmployeeCompensationRun} from "./employee-compensation-run-service";
import {requireCompensationCreationIntent} from "./employee-compensation-creation-intent";
import type {FinanceActorContext} from "./finance-access";

const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
/** Original posted earnings use the existing immutable run writer; recognition remains separately approved. */
export async function createEmployeePercentageCompensationRun(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string;expectedSourceFingerprint?:string}={}){
 const input=employeePercentageRunCreateInput.parse(raw);input.bases.sort((a,b)=>a.postingId.localeCompare(b.postingId)||a.assignmentId.localeCompare(b.assignmentId));const fingerprint=commandFingerprint(input);
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await runs.lockKey(input.idempotencyKey);const existing=await runs.byKey(input.idempotencyKey);
  if(existing){await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),employeeCompensationRunFacts(ctx.organizationId,existing),"create");if(deps.expectedSourceFingerprint||existing.earningKind!=="PERCENTAGE"||existing.createdBy!==ctx.actorId||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return{...employeeCompensationRunModel(ctx,existing),idempotent:true};}
  await requireCompensationCreationIntent(tx,ctx.organizationId,input.idempotencyKey,{actorId:ctx.actorId,earningKind:"PERCENTAGE",requestFingerprint:fingerprint,expectedSourceFingerprint:deps.expectedSourceFingerprint});
  const prepared=await prepareEmployeePercentageRunSources(ctx,{fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,bases:input.bases},tx);if(deps.expectedSourceFingerprint&&deps.expectedSourceFingerprint!==prepared.sourceFingerprint)throw new EmployeeCompensationRunConflictError();await new EmployeePercentageSourceRepository(tx,ctx.organizationId).lockJournals(prepared.source.journals.map(journal=>journal.id));
  const recheck=async()=>{if((await prepareEmployeePercentageRunSources(ctx,{fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,bases:input.bases},tx)).sourceFingerprint!==prepared.sourceFingerprint)throw new EmployeeCompensationRunConflictError();};
  const retained=retainEmployeePercentageRunSources(prepared,input);
  return persistEmployeeCompensationRun(ctx,tx,{earningKind:"PERCENTAGE",createdBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,fromOn:new Date(input.fromOn+"T00:00:00.000Z"),toOn:new Date(input.toOn+"T00:00:00.000Z"),timezone:prepared.window.policy.timezone,currency:input.currency,purpose:input.purpose,reason:input.reason,policyRuleId:prepared.policy.id,policySnapshot:json({schemaVersion:1,policyRuleId:prepared.policy.id,policyVersion:prepared.policy.version,value:prepared.policy.value})},retained.map(row=>row.line),Money.of(prepared.source.amount.amount,input.currency),recheck,deps,async()=>{
   const witnesses=retained.flatMap(row=>row.witnesses.map(witness=>({...witness.data,runLineId:row.line.id})));if((await runs.createPercentageWitnesses(witnesses)).count!==witnesses.length)throw new EmployeeCompensationRunConflictError();
  });
 },{timeout:120000});
}
