import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { recheckAccountAuthorization,type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { taskResource } from "@/platform/authz/task-resource";
import { commandFingerprint as operationHash } from "@/platform/http/command-fingerprint";
import type { FinanceActorContext } from "./finance-access";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { EmployeeWorkTimeRepository } from "../infrastructure/employee-work-time-repository";
import { validateEmployeeCompletedWorkEvidence } from "./employee-compensation-source";
import { employeeHourlyEarningsPolicyKey,employeeHourlyEarningsPolicySchema } from "../domain/employee-hourly-earnings";
import { employeeWorkTimeSubmitSchema,employeeWorkTimeDecisionSchema,employeeWorkTimeReadSchema,employeeWorkTimeRecoverySchema,validateEmployeeWorkTimeIntervals,EmployeeWorkTimeAccessError,EmployeeWorkTimeConflictError,EmployeeWorkTimePolicyError,EmployeeWorkTimeSourceError } from "../domain/employee-work-time";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Evidence=NonNullable<Awaited<ReturnType<EmployeeWorkTimeRepository["evidence"]>>>;
function summary(row:Evidence){return{id:row.id,version:row.version,kind:row.kind,previousEvidenceId:row.previousEvidenceId,submittedAt:row.submittedAt.toISOString(),reason:row.reason,intervals:row.intervals.map(item=>({startsAt:item.startsAt.toISOString(),endsAt:item.endsAt.toISOString(),note:item.note})),decision:row.decision?{id:row.decision.id,verdict:row.decision.verdict,reason:row.decision.reason,decidedAt:row.decision.decidedAt.toISOString()}:null};}
async function retainedTask(ctx:FinanceActorContext,taskId:string,tx:TenantTransaction,action?:"edit"|"validate"){
 const operations=new EmployeeWorkTimeRepository(tx,ctx.organizationId),task=await operations.task(taskId);
 if(!task||task.archivedAt)throw new EmployeeWorkTimeAccessError();
 const resource=taskResource(task),checks:CurrentAuthorityCheck[]=[{action:"view",resource},...(action?[{action,resource}]:[])];
 const check=async()=>{const current=await operations.task(taskId);if(!current||current.archivedAt||operationHash(taskResource(current))!==operationHash(resource))throw new EmployeeWorkTimeAccessError();await recheckAccountAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeWorkTimeAccessError());};
 await check();return{task,resource,check,operations};
}
async function actualSource(ctx:FinanceActorContext,taskId:string,tx:TenantTransaction){const task=await new EmployeeCompensationRepository(tx,ctx.organizationId).completedWork(taskId);if(!task)throw new EmployeeWorkTimeSourceError();try{return{task,...validateEmployeeCompletedWorkEvidence(task)};}catch{throw new EmployeeWorkTimeSourceError();}}
function display(ctx:FinanceActorContext,resource:ReturnType<typeof taskResource>,data:Record<string,unknown>){return present({...ctx.authContext,visibleDataClasses:new Set(["operational" as const])},"view",{...resource,data},{});}
async function privateAudit(ctx:FinanceActorContext,tx:TenantTransaction,task:Awaited<ReturnType<typeof retainedTask>>["task"],action:string,after:Prisma.InputJsonObject,reason:string,deps:Deps,at:Date){return writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action,resourceType:"task",resourceId:task.id,propertyScopeId:task.propertyId,after,reason,requestId:deps.requestId??randomUUID(),occurredAt:at});}

export async function getEmployeeWorkTime(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=employeeWorkTimeReadSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
 const retained=await retainedTask(ctx,input.taskId,tx),repo=new EmployeeWorkTimeRepository(tx,ctx.organizationId),source=await actualSource(ctx,input.taskId,tx),page=await repo.page(input.taskId,input.beforeVersion),current=await repo.latest(input.taskId,source.evidence.completed_by_person_id),now=await new FinanceRepository(tx,ctx.organizationId).clock();
 const rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:employeeHourlyEarningsPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now}),policy=employeeHourlyEarningsPolicySchema.safeParse(rule?.parsedValue);
 const items=page.slice(0,20).map(summary),may=async(action:"edit"|"validate")=>{try{await recheckAccountAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),[{action,resource:retained.resource}],new EmployeeWorkTimeAccessError());return true;}catch(error){if(error instanceof EmployeeWorkTimeAccessError)return false;throw error;}};
 const canSubmit=await may("edit"),canValidate=await may("validate");
 await privateAudit(ctx,tx,retained.task,"operations.work_time.viewed",{evidenceIds:items.map(row=>row.id)},"Read actual operational work intervals without contractual rates",deps,now);
 await retained.check();return display(ctx,retained.resource,{taskId:input.taskId,completedAt:source.evidence.completed_at,latestEvidenceId:current?.id??null,canSubmit,canValidate,policy:policy.success?policy.data:null,items,next:page.length>20?items.at(-1)!.version:null});
});}

export async function submitEmployeeWorkTime(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=employeeWorkTimeSubmitSchema.parse(raw),fingerprint=operationHash(input);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
 const retained=await retainedTask(ctx,input.taskId,tx,"edit"),repo=new EmployeeWorkTimeRepository(tx,ctx.organizationId);
 await retained.operations.lockTask(input.taskId);const source=await actualSource(ctx,input.taskId,tx);await repo.lock(input.taskId,source.evidence.completed_by_person_id);await retained.check();
 const replay=await repo.byKey(input.idempotencyKey);
 if(replay){if(replay.taskId!==input.taskId||replay.submittedByAccountId!==ctx.actorId||replay.requestFingerprint!==fingerprint)throw new EmployeeWorkTimeConflictError();await retained.check();return display(ctx,retained.resource,{taskId:input.taskId,operation:"SUBMISSION",idempotencyKey:input.idempotencyKey,evidence:summary(replay),idempotent:true});}
 const previous=await repo.latest(input.taskId,source.evidence.completed_by_person_id);
 if((previous?.id??null)!==input.previousEvidenceId||!previous&&input.kind==="CANCELLATION"||previous?.kind==="CANCELLATION"&&input.kind==="CANCELLATION")throw new EmployeeWorkTimeConflictError();
 const now=await new FinanceRepository(tx,ctx.organizationId).clock(),rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:employeeHourlyEarningsPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now}),policy=employeeHourlyEarningsPolicySchema.safeParse(rule?.parsedValue),actor=await repo.actor(ctx.actorId);
 if(!rule||rule.scopeType!=="organization"||rule.scopeId!==null||!policy.success)throw new EmployeeWorkTimePolicyError();
 if(!actor||ctx.authContext.personId!==actor.personId)throw new EmployeeWorkTimeAccessError();
 validateEmployeeWorkTimeIntervals(policy.data,source.task.completedAt!,input.kind,input.intervals);
 const created=await repo.create({taskId:input.taskId,propertyId:source.task.propertyId,completionEventId:source.event.id,performedByPersonId:source.evidence.completed_by_person_id,submittedByAccountId:ctx.actorId,submittedByPersonId:actor.personId,policyRuleId:rule.id,previousEvidenceId:previous?.id??null,version:(previous?.version??0)+1,kind:input.kind,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,sourceSnapshot:source.event.after as Prisma.InputJsonObject,policySnapshot:policy.data,reason:input.reason},input.intervals);
 await privateAudit(ctx,tx,retained.task,"operations.work_time.submitted",{evidenceId:created.id,version:created.version,kind:created.kind,intervalCount:created.intervals.length},input.reason,deps,created.submittedAt);
 await repo.event("EmployeeWorkTimeSubmitted",{evidenceId:created.id,taskId:input.taskId,version:created.version},"employee-work-time:"+created.id+":submitted",created.submittedAt);
 const finalPolicy=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:employeeHourlyEarningsPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await new FinanceRepository(tx,ctx.organizationId).clock()});
 if(finalPolicy?.id!==rule.id)throw new EmployeeWorkTimePolicyError();await retained.check();await repo.flushGuards();return display(ctx,retained.resource,{taskId:input.taskId,operation:"SUBMISSION",idempotencyKey:input.idempotencyKey,evidence:summary(created),idempotent:false});
});}

export async function decideEmployeeWorkTime(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=employeeWorkTimeDecisionSchema.parse(raw),fingerprint=operationHash(input);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
 const retained=await retainedTask(ctx,input.taskId,tx,"validate"),repo=new EmployeeWorkTimeRepository(tx,ctx.organizationId);
 await retained.operations.lockTask(input.taskId);const source=await actualSource(ctx,input.taskId,tx);await repo.lock(input.taskId,source.evidence.completed_by_person_id);await retained.check();
 const replay=await repo.decisionByKey(input.idempotencyKey),evidence=await repo.evidence(input.evidenceId);
 if(!evidence||evidence.taskId!==input.taskId)throw new EmployeeWorkTimeAccessError();
 if(replay){if(replay.evidenceId!==input.evidenceId||replay.decidedByAccountId!==ctx.actorId||replay.requestFingerprint!==fingerprint)throw new EmployeeWorkTimeConflictError();await retained.check();return display(ctx,retained.resource,{taskId:input.taskId,operation:"DECISION",idempotencyKey:input.idempotencyKey,evidence:summary(evidence),idempotent:true});}
 const latest=await repo.latest(input.taskId,source.evidence.completed_by_person_id),actor=await repo.actor(ctx.actorId),policy=employeeHourlyEarningsPolicySchema.safeParse(evidence.policySnapshot);
 if(!actor||actor.personId!==ctx.authContext.personId)throw new EmployeeWorkTimeAccessError();
 if(latest?.id!==evidence.id||evidence.decision)throw new EmployeeWorkTimeConflictError();
 if(!policy.success)throw new EmployeeWorkTimePolicyError();
 if(policy.data.require_distinct_validator&&actor.personId===evidence.performedByPersonId)throw new EmployeeWorkTimeAccessError();
 const decision=await repo.decide({evidenceId:evidence.id,decidedByAccountId:ctx.actorId,decidedByPersonId:actor.personId,verdict:input.verdict,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,reason:input.reason});
 await privateAudit(ctx,tx,retained.task,"operations.work_time.decided",{evidenceId:evidence.id,decisionId:decision.id,verdict:decision.verdict},input.reason,deps,decision.decidedAt);
 await repo.event("EmployeeWorkTimeDecided",{evidenceId:evidence.id,decisionId:decision.id,taskId:input.taskId,verdict:decision.verdict},"employee-work-time-decision:"+decision.id+":decided",decision.decidedAt);
 await retained.check();await repo.flushGuards();return display(ctx,retained.resource,{taskId:input.taskId,operation:"DECISION",idempotencyKey:input.idempotencyKey,evidence:summary({...evidence,decision}),idempotent:false});
});}

export async function recoverEmployeeWorkTime(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=employeeWorkTimeRecoverySchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
 const retained=await retainedTask(ctx,input.taskId,tx,input.operation==="SUBMISSION"?"edit":"validate"),repo=new EmployeeWorkTimeRepository(tx,ctx.organizationId);
 let evidence:Evidence|null=null;
 if(input.operation==="SUBMISSION"){const row=await repo.byKey(input.key);if(row){if(row.taskId!==input.taskId||row.submittedByAccountId!==ctx.actorId)throw new EmployeeWorkTimeAccessError();evidence=row;}}
 else{const decision=await repo.decisionByKey(input.key);if(decision){if(decision.decidedByAccountId!==ctx.actorId)throw new EmployeeWorkTimeAccessError();evidence=await repo.evidence(decision.evidenceId);if(!evidence||evidence.taskId!==input.taskId)throw new EmployeeWorkTimeAccessError();}}
 const now=await new FinanceRepository(tx,ctx.organizationId).clock();
 await privateAudit(ctx,tx,retained.task,"operations.work_time.recovered",{evidenceId:evidence?.id??null,operation:input.operation},"Recover the actual actor-scoped operational work command receipt",deps,now);
 await retained.check();return{receipt:evidence?display(ctx,retained.resource,{taskId:input.taskId,operation:input.operation,idempotencyKey:input.key,evidence:summary(evidence),idempotent:true}):null};
});}
