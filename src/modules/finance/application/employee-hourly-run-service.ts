import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeHourlyRunCreateInput } from "../domain/employee-hourly-run";
import { EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { employeeCompensationRunModel,persistEmployeeCompensationRun } from "./employee-compensation-run-service";
import { prepareEmployeeHourlyRunSources } from "./employee-hourly-run-source";
import type { FinanceActorContext } from "./finance-access";
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

/** Retain approved actual intervals and every original effective contract in the shared immutable writer. */
export async function createEmployeeHourlyCompensationRun(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string;expectedSourceFingerprint?:string}={}){
 const input=employeeHourlyRunCreateInput.parse(raw);input.jobs.sort((a,b)=>a.taskId.localeCompare(b.taskId));const fingerprint=commandFingerprint(input);
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await runs.lockKey(input.idempotencyKey);
  const existing=await runs.byKey(input.idempotencyKey);
  if(existing){await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),employeeCompensationRunFacts(ctx.organizationId,existing),"create");if(deps.expectedSourceFingerprint||existing.earningKind!=="PER_HOUR"||existing.createdBy!==ctx.actorId||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return{...employeeCompensationRunModel(ctx,existing),idempotent:true};}
  const source=await prepareEmployeeHourlyRunSources(ctx,{fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,jobs:input.jobs},tx);
  if(deps.expectedSourceFingerprint&&deps.expectedSourceFingerprint!==source.sourceFingerprint)throw new EmployeeCompensationRunConflictError();
  const lines=source.lines.map(line=>({id:crypto.randomUUID(),earningKind:"PER_HOUR",personId:line.personId,assignmentId:line.assignmentId,compensationId:line.compensationId,configRuleId:line.configRuleId,taskId:line.taskId,completionEventId:line.completionEventId,propertyId:line.propertyId,recordedCompletionAt:line.recordedCompletionAt,workTimeEvidenceId:line.evidenceId,workTimeDecisionId:line.decisionId,rate:line.rate.amount,amount:line.amount.amount,currency:input.currency,sourceSnapshot:json(line.sourceSnapshot)}));
  const byTask=new Map(lines.map(line=>[line.taskId,line.id]));
  return persistEmployeeCompensationRun(ctx,tx,{earningKind:"PER_HOUR",createdBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,fromOn:new Date(input.fromOn+"T00:00:00.000Z"),toOn:new Date(input.toOn+"T00:00:00.000Z"),timezone:source.window.policy.timezone,currency:input.currency,purpose:input.purpose,reason:input.reason,policyRuleId:source.policy.id,policySnapshot:json({schemaVersion:1,policyRuleId:source.policy.id,policyVersion:source.policy.version,value:source.policy.value})},lines,Money.of(source.amount.amount,source.currency),source.recheck,deps,async()=>{
   const witnesses=source.lines.flatMap(line=>line.witnesses.map((witness,position)=>({runLineId:byTask.get(line.taskId)!,intervalId:witness.intervalId,compensationId:witness.compensationId,configRuleId:witness.configRuleId,position,startsAt:witness.startsAt,endsAt:witness.endsAt})));
   if((await runs.createHourlyWitnesses(witnesses)).count!==witnesses.length)throw new EmployeeCompensationRunConflictError();
  });
 },{timeout:120000});
}
