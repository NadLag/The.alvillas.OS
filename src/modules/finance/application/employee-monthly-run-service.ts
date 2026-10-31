import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { employeeMonthlyRunSourceInput,prepareEmployeeMonthlyRunSources } from "./employee-monthly-run-source";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { employeeCompensationRunModel,persistEmployeeCompensationRun } from "./employee-compensation-run-service";
import type { FinanceActorContext } from "./finance-access";
export const employeeMonthlyRunCreateInput=employeeMonthlyRunSourceInput.safeExtend({purpose:z.string().trim().min(3).max(1000),reason:z.string().trim().min(6).max(500),idempotencyKey:z.uuid().transform(value=>value.toLowerCase())});
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
/** Persist actual completed calendar coverage through the existing immutable run writer and receipts. */
export async function createEmployeeMonthlyCompensationRun(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=employeeMonthlyRunCreateInput.parse(raw);input.assignments.sort((a,b)=>a.assignmentId.localeCompare(b.assignmentId));const fingerprint=createHash("sha256").update(JSON.stringify(input)).digest("hex");
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await runs.lockKey(input.idempotencyKey);const existing=await runs.byKey(input.idempotencyKey);
  if(existing){await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),employeeCompensationRunFacts(ctx.organizationId,existing),"create");if(existing.earningKind!=="PER_MONTH"||existing.createdBy!==ctx.actorId||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return{...employeeCompensationRunModel(ctx,existing),idempotent:true};}
  const source=await prepareEmployeeMonthlyRunSources(ctx,{month:input.month,currency:input.currency,assignments:input.assignments},tx),earnedAt=new Date(source.endsAt.getTime()-1),calendar=new Map(source.calendarPoints.map(point=>[point.on,point.startsAt]));
  const lines=source.lines.map(line=>({earningKind:"PER_MONTH",earningPeriodKey:source.month,personId:line.personId,assignmentId:line.assignmentId,compensationId:line.compensationId,configRuleId:line.configRuleId,taskId:line.taskId,completionEventId:null,propertyId:line.propertyId,sourceCityId:line.sourceCityId,sourceRegionId:line.sourceRegionId,recordedCompletionAt:earnedAt,rate:line.rate.amount,amount:line.amount.amount,currency:input.currency,sourceSnapshot:json(line.sourceSnapshot)}));
  return persistEmployeeCompensationRun(ctx,tx,{earningKind:"PER_MONTH",createdBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,fromOn:new Date(source.fromOn+"T00:00:00.000Z"),toOn:new Date(source.toOn+"T00:00:00.000Z"),timezone:source.timezone,currency:input.currency,purpose:input.purpose,reason:input.reason,policyRuleId:source.policy.id,policySnapshot:json({schemaVersion:1,policyRuleId:source.policy.id,policyVersion:source.policy.version,value:source.policy.value})},lines,Money.of(source.amount.amount,source.currency),source.recheck,deps,async runId=>{const stored=await runs.sourceSnapshots(runId),byAssignment=new Map(stored.map(line=>[line.assignmentId,line.id])),witnesses=source.lines.flatMap(line=>line.sourceSnapshot.days.map(day=>({runLineId:byAssignment.get(line.assignmentId)!,sourceOn:new Date(day.on+"T00:00:00.000Z"),occurredAt:calendar.get(day.on)!,eligible:day.eligible,compensationId:day.compensation?.id??null,configRuleId:day.rule?.id??null})));if((await runs.createContractWitnesses(witnesses)).count!==witnesses.length)throw new EmployeeCompensationRunConflictError();});
 },{timeout:120000});
}
