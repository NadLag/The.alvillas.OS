import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { Money } from "@/platform/money/money";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { EmployeeCompensationRunRepository, type CompensationRunRecord } from "../infrastructure/employee-compensation-run-repository";
import { employeeCompensationRunCreateSchema, employeeCompensationRunCancelSchema, employeeCompensationRunPolicyKey,
  employeeCompensationRunWindow, employeeCompensationRunViewSchema, EmployeeCompensationRunAccessError, EmployeeCompensationRunConflictError, EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { validateEmployeeCompletedWorkSource, validateEmployeeCompensationAssignment, validateEmployeeCompensationRate } from "./employee-compensation-source";
import { employeeCompensationRunFacts, recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const stable = (value: unknown) => JSON.stringify(value);
const orderedTasks = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a,b) => a.id.localeCompare(b.id));

export function employeeCompensationRunModel(ctx: FinanceActorContext, row: CompensationRunRecord, after?: string) {
  if (after && !row.lines.some(line => line.id === after)) throw new EmployeeCompensationRunAccessError();
  const facts = employeeCompensationRunFacts(ctx.organizationId, row), remaining = row.lines.filter(line => !after || line.id > after);
  const page = remaining.slice(0,50);
  const data = { id: row.id, kind: "COMPLETED_WORK_DRAFT" as const, state: row.cancellation ? "CANCELLED" as const : "DRAFT" as const,
    purpose: row.purpose, fromOn: row.fromOn.toISOString().slice(0,10), toOn: row.toOn.toISOString().slice(0,10), timezone: row.timezone,
    currency: row.currency, createdAt: row.createdAt.toISOString(), total: facts.total.toJSON(), lineCount: row.lines.length,
    lines: page.map(line => ({ id: line.id, taskId: line.taskId, personId: line.personId, propertyId: line.propertyId, assignmentId: line.assignmentId,
      completionEventId: line.completionEventId, recordedCompletionAt: line.recordedCompletionAt.toISOString(),
      rate: Money.of(line.rate.toString(), line.currency).toJSON(), amount: Money.of(line.amount.toString(), line.currency).toJSON() })),
    nextCursor: remaining.length>50 ? page.at(-1)!.id : null,
    history: [{ action: "CREATED" as const, at: row.createdAt.toISOString(), reason: row.reason },
      ...(row.cancellation ? [{ action: "CANCELLED" as const, at: row.cancellation.createdAt.toISOString(), reason: row.cancellation.reason }] : [])] };
  const result=employeeCompensationRunViewSchema.safeParse(present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...facts.resource, data }, catalogFieldPolicy<typeof data>("employee_payable")));
  if(!result.success)throw Error("Compensation run presentation is unavailable");return result.data;
}

async function checkStoredRun(ctx: FinanceActorContext, tx: TenantTransaction, row: CompensationRunRecord, action: "view" | "create" | "void" = "view") {
  await recheckEmployeeCompensationRun(ctx, tx, await new FinanceRepository(tx, ctx.organizationId).clock(), employeeCompensationRunFacts(ctx.organizationId,row), action);
}

/** Persist the expected contractual work and original evidence; payable recognition has a separate approval boundary. */
export async function createEmployeeCompensationRun(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = employeeCompensationRunCreateSchema.parse(raw);
  input.jobs.sort((a,b) => a.taskId.localeCompare(b.taskId));
  const fingerprint = createHash("sha256").update(stable(input)).digest("hex");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new EmployeeCompensationRunRepository(tx,ctx.organizationId), finance = new FinanceRepository(tx,ctx.organizationId);
    await repository.lockKey(input.idempotencyKey);
    const existing = await repository.byKey(input.idempotencyKey);
    if (existing) {
      await checkStoredRun(ctx,tx,existing,"create");
      if (existing.createdBy!==ctx.actorId || existing.requestFingerprint!==fingerprint) throw new EmployeeCompensationRunConflictError();
      return { ...employeeCompensationRunModel(ctx,existing), idempotent: true };
    }
    const now = await finance.clock(), sources = new EmployeeCompensationRepository(tx,ctx.organizationId), config = new ConfigRuleRepository(tx,ctx.organizationId);
    const tasks = orderedTasks(await sources.completedWorks(input.jobs.map(job=>job.taskId)));
    if (tasks.length!==input.jobs.length || tasks.some(task=>task.state!=="COMPLETED" || !task.completedAt || !task.completedByPersonId)) throw new EmployeeCompensationRunAccessError();
    const taskMap = new Map(tasks.map(task=>[task.id,task]));
    const entries = input.jobs.map(job=>({key:job.taskId,assignmentId:job.assignmentId,earnedAt:taskMap.get(job.taskId)!.completedAt!}));
    const contracts = await sources.sources(entries);
    const records = input.jobs.map(job=>{
      const task=taskMap.get(job.taskId)!,source=contracts.get(job.taskId);
      if (!source?.rate || source.assignment.personId!==task.completedByPersonId || source.rate.currency!==input.currency) throw new EmployeeCompensationRunAccessError();
      return {job,task,source,rate:source.rate};
    });
    const provisional: Pick<CompensationRunRecord,"id"|"currency"|"createdAt"|"lines"> = {id:"",currency:input.currency,createdAt:now,
      lines:records.map(({job,task,source,rate})=>({id:task.id,taskId:task.id,personId:source.assignment.personId,propertyId:task.propertyId,
        assignmentId:job.assignmentId,compensationId:rate.id,configRuleId:rate.configRuleId,completionEventId:task.events[0]?.id??task.id,
        recordedCompletionAt:task.completedAt!,rate:rate.amount,amount:rate.amount,currency:input.currency,property:task.property}))};
    const facts = employeeCompensationRunFacts(ctx.organizationId,provisional);
    await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,"create");
    for(const record of records){validateEmployeeCompensationAssignment(record.source,record.task.completedAt!);validateEmployeeCompletedWorkSource(record.task,record.source);}
    const scopeGroups = new Map(entries.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}]));
    const rules = await config.resolveDatedScopeGroups("staff.compensation",scopeGroups);
    const rule = await config.resolve({key:employeeCompensationRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
    if(!rule || rule.scopeType!=="organization" || rule.scopeId!==null) throw new EmployeeCompensationRunPolicyError();
    const window = employeeCompensationRunWindow(input.fromOn,input.toOn,rule.parsedValue);
    requireCurrentTimezoneData();
    const databaseWindow = await repository.window(input.fromOn,input.toOn,window.policy.timezone);
    if(databaseWindow.startsAt.getTime()!==window.startsAt.getTime() || databaseWindow.endsAt.getTime()!==window.endsAt.getTime()) throw new EmployeeCompensationRunPolicyError();
    const lines = records.map(({task,source,rate})=>{
      if(task.completedAt!<window.startsAt || task.completedAt!>=window.endsAt) throw new EmployeeCompensationRunPolicyError();
      const contractRule=validateEmployeeCompensationRate(source,rules.get(task.id)??null),{event}=validateEmployeeCompletedWorkSource(task,source);
      const amount=Money.of(rate.amount.toString(),input.currency).toJSON();
      return {personId:source.assignment.personId,assignmentId:source.assignment.id,compensationId:rate.id,configRuleId:contractRule.id,
        taskId:task.id,completionEventId:event.id,propertyId:task.propertyId,recordedCompletionAt:task.completedAt!,rate:amount.amount,amount:amount.amount,currency:input.currency,
        sourceSnapshot:json({schemaVersion:1,kind:"COMPLETED_JOB_ESTIMATE",personId:source.assignment.personId,assignmentId:source.assignment.id,
          compensationId:rate.id,compensationVersion:rate.version,configRuleId:contractRule.id,configVersion:contractRule.version,
          taskId:task.id,completionEventId:event.id,completionVersion:event.version,recordedCompletionAt:task.completedAt!.toISOString(),
          completionEvent:event,contractRule:{id:contractRule.id,version:contractRule.version,value:contractRule.value},
          assignment:source.assignment,basis:{mode:"PER_JOB",jobs:"1"},rate:amount,amount})};
    });
    const recheck = async()=>{
      if(stable(orderedTasks(await sources.completedWorks(input.jobs.map(job=>job.taskId))))!==stable(tasks) ||
        stable([...(await sources.sources(entries))])!==stable([...contracts])) throw new EmployeeCompensationRunAccessError();
      const currentRules=await config.resolveDatedScopeGroups("staff.compensation",scopeGroups);
      if(stable([...currentRules])!==stable([...rules])) throw new EmployeeCompensationRunAccessError();
      const currentPolicy=await config.resolve({key:employeeCompensationRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
      if(stable(currentPolicy)!==stable(rule)) throw new EmployeeCompensationRunPolicyError();
      await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,"create");
    };
    await recheck();
    const created = await repository.create({createdBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,
      fromOn:new Date(input.fromOn+"T00:00:00.000Z"),toOn:new Date(input.toOn+"T00:00:00.000Z"),timezone:window.policy.timezone,currency:input.currency,
      purpose:input.purpose,reason:input.reason,policyRuleId:rule.id,policySnapshot:json({schemaVersion:1,policyRuleId:rule.id,policyVersion:rule.version,value:rule.value})});
    const result=await repository.createLines(created.id,lines);
    if(result.count!==lines.length) throw new EmployeeCompensationRunConflictError();
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation_run.created",resourceType:"employee_compensation_run",
      resourceId:created.id,after:{runId:created.id,kind:"COMPLETED_WORK_DRAFT",lineCount:lines.length,total:facts.total.toJSON()},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    await new OutboxRepository(tx,ctx.organizationId).append("EmployeeCompensationRunCreated",{runId:created.id},`employee-compensation-run:${created.id}:created`,await finance.clock());
    await repository.flushGuards();await recheck();
    const row=await repository.find(created.id);if(!row)throw new EmployeeCompensationRunConflictError();
    await checkStoredRun(ctx,tx,row,"create");
    return {...employeeCompensationRunModel(ctx,row),idempotent:false};
  },{timeout:120000});
}

export const employeeCompensationRunReadInput=z.object({id:z.uuid(),after:z.uuid().optional()}).strict();
export async function readEmployeeCompensationRunInTransaction(ctx: FinanceActorContext,input:z.infer<typeof employeeCompensationRunReadInput>,tx:TenantTransaction,deps:Deps={}){
    const repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId),row=await repository.find(input.id);
    if(!row)throw new EmployeeCompensationRunAccessError();await checkStoredRun(ctx,tx,row);
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation_run.viewed",resourceType:"employee_compensation_run",
      resourceId:row.id,after:{runId:row.id,kind:"COMPLETED_WORK_DRAFT"},reason:"Viewed an authorized compensation run",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await new FinanceRepository(tx,ctx.organizationId).clock()});
    const current=await repository.find(row.id);if(!current||stable(current)!==stable(row))throw new EmployeeCompensationRunAccessError();
    await checkStoredRun(ctx,tx,current);return {model:employeeCompensationRunModel(ctx,current,input.after),record:current};
}
export async function getEmployeeCompensationRun(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input=employeeCompensationRunReadInput.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>(await readEmployeeCompensationRunInTransaction(ctx,input,tx,deps)).model,{timeout:120000});
}

export async function cancelEmployeeCompensationRun(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input=employeeCompensationRunCancelSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId);await repository.lock(input.id);
    const row=await repository.find(input.id);if(!row)throw new EmployeeCompensationRunAccessError();await checkStoredRun(ctx,tx,row,"void");
    if(row.cancellation){if(row.cancellation.cancelledBy!==ctx.actorId||row.cancellation.reason!==input.reason)throw new EmployeeCompensationRunConflictError();return{id:row.id,idempotent:true};}
    const cancelled=await repository.cancel(row.id,ctx.actorId,input.reason);
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation_run.cancelled",resourceType:"employee_compensation_run",
      resourceId:row.id,after:{runId:row.id,cancellationId:cancelled.id},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await new FinanceRepository(tx,ctx.organizationId).clock()});
    await new OutboxRepository(tx,ctx.organizationId).append("EmployeeCompensationRunCancelled",{runId:row.id},`employee-compensation-run:${row.id}:cancelled`,await new FinanceRepository(tx,ctx.organizationId).clock());
    await repository.flushGuards();
    const current=await repository.find(row.id);
    if(!current||stable(current.lines)!==stable(row.lines)||current.cancellation?.id!==cancelled.id)throw new EmployeeCompensationRunAccessError();
    await checkStoredRun(ctx,tx,current,"void");return{id:row.id,idempotent:false};
  },{timeout:120000});
}
