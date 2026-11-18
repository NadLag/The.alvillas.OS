import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorizationScopeStamp } from "@/platform/authz/authority-stamp";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { maintenanceSlaPolicyKey, maintenanceSlaPolicySchema } from "@/platform/config/maintenance-sla-policy";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { inspectMaintenanceIssueSource, maintenanceAuthorityStamp } from "@/platform/maintenance/issue-sources";
import { maintenanceSourceCursor, readMaintenanceSourceCursor } from "@/platform/maintenance/source-cursor";
import {
  contractorChoicesSchema, contractorPrioritySchema, contractorSearchSchema, contractorWorkspaceSchema,
  maintenanceContractorChangeSchema, maintenanceSlaDeadlines, maintenanceSlaMilestone
} from "../domain/contractor-sla";
import { MaintenanceIssueAccessError } from "../domain/issue-context";
import { WorkOrderAccessError, WorkOrderConflictError } from "../domain/work-order";
import { ContractorAssignmentRepository } from "../infrastructure/contractor-assignment-repository";
import { MaintenanceIssueContextRepository } from "../infrastructure/issue-context-repository";
import { WorkOrderRepository } from "../infrastructure/work-order-repository";
import { findRegisteredWorkOrder, workOrderActor } from "./work-order-access";

type Dependencies = { db?: TenantTransactionRunner; requestId?: string };
type Order = Awaited<ReturnType<typeof findRegisteredWorkOrder>>;
type Assignment = Awaited<ReturnType<ContractorAssignmentRepository["history"]>>[number];
const readInput = z.object({ taskId: z.uuid(), cursor: z.string().max(6000).optional() }).strict();
const closedStates = new Set(["COMPLETED", "SKIPPED", "CANCELLED"]);

function resolvedPolicy(organizationId: string, tx: TenantTransaction, order: Order, now: Date) {
  const property = order.task.task.property;
  return new ConfigRuleRepository(tx, organizationId).resolve({ key: maintenanceSlaPolicyKey, asOf: now, scopes: [
    { scopeType: "property", scopeId: property.id },
    ...(property.cityId ? [{ scopeType: "city" as const, scopeId: property.cityId }] : []),
    ...(property.regionId ? [{ scopeType: "region" as const, scopeId: property.regionId }] : []),
    { scopeType: "organization", scopeId: null }
  ] });
}

async function contractor(actor: AccountActorContext, tx: TenantTransaction, order: Order, id: string) {
  try {
    return await inspectMaintenanceIssueSource(actor, tx, { kind: "SUPPLIER", id }, order.issue.context);
  } catch (error) {
    if (error instanceof MaintenanceIssueAccessError) throw new WorkOrderAccessError();
    throw error;
  }
}

export async function changeMaintenanceContractor(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = workOrderActor(context), input = maintenanceContractorChangeSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const assignments = new ContractorAssignmentRepository(tx, actor.organizationId);
    const orders = new WorkOrderRepository(tx, actor.organizationId);
    await orders.lockActor(actor.actorId, input.idempotencyKey);
    const previous = await assignments.byNonce(actor.actorId, input.idempotencyKey), requestHash = jsonbFingerprint(input);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new WorkOrderConflictError();
      return { recorded: true };
    }
    await orders.lockTask(input.taskId);
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const order = await findRegisteredWorkOrder(actor, tx, input.taskId, "assign");
    const [latest] = await assignments.history(input.taskId, 1, undefined);
    if ((latest?.revision ?? 0) !== input.expectedRevision || (latest?.contractorId ?? null) === input.contractorId ||
        closedStates.has(order.task.task.state)) throw new WorkOrderConflictError();
    if (input.contractorId === null && latest?.contractorId)
      await contractor(actor, tx, order, latest.contractorId);
    const now = await orders.clock();
    const source = input.contractorId ? await contractor(actor, tx, order, input.contractorId) : null;
    const policy = source ? await resolvedPolicy(actor.organizationId, tx, order, now) : null;
    if (source && !policy) throw new WorkOrderConflictError();
    const priority = source ? contractorPrioritySchema.parse(order.task.task.priority) : null;
    const deadlines = priority && policy ? maintenanceSlaDeadlines(now, maintenanceSlaPolicySchema.parse(policy.parsedValue), priority) :
      { responseDueAt: null, completionDueAt: null };
    const revision = input.expectedRevision + 1;
    const row = await assignments.append({ ...input, ...deadlines, actorId: actor.actorId, createdAt: now,
      ruleId: policy?.id ?? null, requestHash, revision, priority });
    const event = { assignmentId: row.id, revision, assigned: Boolean(source) };
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.actorId,
      action: "maintenance.work_order.contractor_changed", resourceType: "maintenance_work_order", resourceId: input.taskId,
      propertyScopeId: order.task.task.propertyId, after: event, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await orders.outbox.append("maintenance.work_order.contractor_changed", { ...event, taskId: input.taskId },
      "maintenance-contractor:" + actor.actorId + ":" + input.idempotencyKey, now);
    await source?.recheck();
    await order.recheck();
    if (policy && (await resolvedPolicy(actor.organizationId, tx, order, now))?.id !== policy.id)
      throw new WorkOrderConflictError();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return { recorded: true };
  });
}

function milestone(dueAt: Date, reachedAt: Date | null, now: Date, cancelled: boolean) {
  return { dueAt: dueAt.toISOString(), reachedAt: reachedAt?.toISOString() ?? null,
    state: maintenanceSlaMilestone(dueAt, reachedAt, now, cancelled) };
}

async function presentAssignment(actor: AccountActorContext, tx: TenantTransaction, order: Order,
  repository: ContractorAssignmentRepository, row: Assignment, now: Date) {
  const revision = row.revision, at = row.createdAt.toISOString();
  if (!row.contractorId) return { state: "CLEARED" as const, revision, at };
  try {
    const original = await contractor(actor, tx, order, row.contractorId);
    const upperBound = row.supersededAt ?? now;
    const activity = await repository.milestones(row.taskId, row.createdAt, upperBound);
    const until = activity.closedAt ?? upperBound;
    const completedAt = order.task.task.completedAt;
    const completion = completedAt && completedAt >= row.createdAt && completedAt <= until ? completedAt : null;
    const response = activity.responseAt ?? completion;
    const ended = Boolean(row.supersededAt ?? activity.closedAt);
    await original.recheck();
    return { state: "ASSIGNED" as const, contractor: { id: row.contractorId, label: original.label }, revision, at, reason: row.reason,
      priority: contractorPrioritySchema.parse(row.priority),
      response: milestone(row.responseDueAt!, response, until, ended),
      completion: milestone(row.completionDueAt!, completion, until, ended) };
  } catch (error) {
    if (error instanceof WorkOrderAccessError || error instanceof MaintenanceIssueAccessError) return { state: "MASKED" as const };
    throw error;
  }
}

export async function readMaintenanceContractor(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = workOrderActor(context), input = readInput.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const order = await findRegisteredWorkOrder(actor, tx, input.taskId);
    const repository = new ContractorAssignmentRepository(tx, actor.organizationId);
    const now = await new WorkOrderRepository(tx, actor.organizationId).clock();
    const filter = jsonbFingerprint({ purpose: "MAINTENANCE_CONTRACTOR_HISTORY", taskId: input.taskId, stamp,
      scope: authorizationScopeStamp(actor.authContext) });
    const before = readMaintenanceSourceCursor(actor, filter, input.cursor);
    const rows = await repository.history(input.taskId, 21, before);
    const latest = before ? (await repository.history(input.taskId, 1, undefined))[0] : rows[0];
    let canChange = false;
    if (!closedStates.has(order.task.task.state)) {
      try {
        await findRegisteredWorkOrder(actor, tx, input.taskId, "assign");
        canChange = true;
      } catch (error) {
        if (!(error instanceof WorkOrderAccessError)) throw error;
      }
    }
    const policy = canChange ? await resolvedPolicy(actor.organizationId, tx, order, now) : null;
    const history = [];
    for (const row of rows.slice(0, 20)) history.push(await presentAssignment(actor, tx, order, repository, row, now));
    const current = latest ? before ? await presentAssignment(actor, tx, order, repository, latest, now) : history[0] : null;
    await order.recheck();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return contractorWorkspaceSchema.parse({ authorizationStamp: stamp, timeZone: order.task.task.property.timezone, canAssign: canChange && Boolean(policy),
      canClear: canChange && current?.state === "ASSIGNED", canChange, policyAvailable: Boolean(policy),
      revision: latest?.revision ?? 0, current, history, next: rows.length > 20 ? maintenanceSourceCursor(actor, filter, rows[19].id) : null });
  });
}

export async function searchMaintenanceContractors(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = workOrderActor(context), input = contractorSearchSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const order = await findRegisteredWorkOrder(actor, tx, input.taskId, "assign");
    if (closedStates.has(order.task.task.state)) throw new WorkOrderConflictError();
    const filter = jsonbFingerprint({ purpose: "MAINTENANCE_CONTRACTOR_CHOICES", taskId: input.taskId, query: input.query,
      stamp, scope: authorizationScopeStamp(actor.authContext) });
    const before = readMaintenanceSourceCursor(actor, filter, input.cursor);
    const choices = await new MaintenanceIssueContextRepository(tx, actor.organizationId).candidates({
      kind: "SUPPLIER", query: input.query, propertyId: order.task.task.propertyId, before
    });
    const items = [];
    for (const choice of choices.slice(0, 20)) {
      try {
        const original = await contractor(actor, tx, order, choice.id);
        await original.recheck();
        items.push({ id: choice.id, label: original.label });
      } catch (error) {
        if (!(error instanceof WorkOrderAccessError || error instanceof MaintenanceIssueAccessError)) throw error;
      }
    }
    await order.recheck();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return contractorChoicesSchema.parse({ authorizationStamp: stamp, items,
      next: choices.length > 20 ? maintenanceSourceCursor(actor, filter, choices[19].id) : null });
  });
}
