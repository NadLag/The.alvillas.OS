import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorizationScopeStamp } from "@/platform/authz/authority-stamp";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { expenseResource } from "@/platform/authz/expense-resource";
import { present } from "@/platform/authz/present";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { maintenanceAuthorityStamp } from "@/platform/maintenance/issue-sources";
import { maintenanceSourceCursor, readMaintenanceSourceCursor } from "@/platform/maintenance/source-cursor";
import { readWorkOrderExpense } from "@/platform/maintenance/work-order-expense-source";
import { readWorkOrderInvoice } from "@/platform/maintenance/work-order-invoice-source";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { workOrderCostPolicy, lockWorkOrderFinancialSource } from "@/platform/maintenance/work-order-finance-policy";
import { Money } from "@/platform/money/money";
import { WorkOrderAccessError, WorkOrderConflictError } from "../domain/work-order";
import {
  estimateSnapshotSchema, workOrderFinanceCommandSchema, workOrderFinanceHistorySchema,
  workOrderFinanceIntentSchema, workOrderFinanceReviewSchema, workOrderFinanceSearchSchema,
  workOrderFinanceChoicesSchema, type WorkOrderFinanceIntent
} from "../domain/work-order-finance";
import { WorkOrderFinanceRepository } from "../infrastructure/work-order-finance-repository";
import { WorkOrderRepository } from "../infrastructure/work-order-repository";
import { findRegisteredWorkOrder as findOrder, workOrderActor as actorFor } from "./work-order-access";

type Dependencies = { db?: TenantTransactionRunner; requestId?: string };
type Estimate = Extract<WorkOrderFinanceIntent, { kind: "estimate" }>;
type EstimateFacts = Estimate["fields"] & { id?: string; actorId?: string };

type Order = Awaited<ReturnType<typeof findOrder>>;
function financeResource(actor: AccountActorContext, order: Order, facts?: EstimateFacts) {
  const task = order.task.task;
  const resource = expenseResource(actor.organizationId, task.property, {
    id: facts?.id ?? task.id, amount: facts?.amount ?? "0", reservationId: task.reservationId,
    state: "DRAFT", occurredOn: facts ? new Date(facts.occurredOn) : task.dueDate,
    createdBy: facts?.actorId ?? actor.actorId
  });
  return facts?.id ? resource : { ...resource, id: undefined, financialRecordId: undefined, amount: facts?.amount };
}

async function verifyFinance(actor: AccountActorContext, tx: TenantTransaction, order: Order, action: "view" | "create", facts?: EstimateFacts) {
  const resource = financeResource(actor, order, facts);
  const now = await new WorkOrderRepository(tx, actor.organizationId).clock();
  await recheckAccountAuthorization(actor, tx, now, [{ action: "view", resource }, { action, resource }], new WorkOrderAccessError());
  return { resource, now };
}

async function readEvidence(actor: AccountActorContext, tx: TenantTransaction, order: Order, kind: "expense" | "invoice", sourceId: string) {
  const task = order.task.task;
  if (kind === "invoice") {
    return readWorkOrderInvoice(actor, tx, { invoiceId: sourceId, propertyId: task.propertyId, reservationId: task.reservationId });
  }
  const expense = await readWorkOrderExpense(actor, tx, { expenseId: sourceId, propertyId: task.propertyId, reservationId: task.reservationId });
  return { id: expense.id, version: expense.version, state: expense.state, label: expense.purpose, money: expense.money, approvalId: expense.approvalId };
}

async function estimate(actor: AccountActorContext, tx: TenantTransaction, order: Order, intent: Estimate, repository: WorkOrderFinanceRepository) {
  const task = order.task.task;
  const money = Money.of(intent.fields.amount, intent.fields.currency);
  const fields = { ...intent.fields, ...money.toJSON() };
  const { resource, now } = await verifyFinance(actor, tx, order, "create", fields);
  const currency = await repository.currency(fields.currency);
  if (!currency || currency.minorUnit > 2 || money.amount.decimalPlaces() > currency.minorUnit) throw new WorkOrderConflictError();
  const latest = await repository.latestEstimate(task.id);
  const revision = (latest?.revision ?? 0) + 1;
  if (revision - 1 !== intent.expectedRevision || latest?.approvalState === "PENDING") throw new WorkOrderConflictError();
  const plan = await workOrderCostPolicy(actor, tx, resource, now, task, fields, revision);
  const detail = estimateSnapshotSchema.parse({ fields, allocation: plan.snapshot.allocation,
    approvalSteps: [...new Set(plan.stages.map(stage => stage.kind))] });
  return {
    detail: present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { ...resource, data: {
      ...detail, kind: "estimate" as const, revision
    } }, {}, now),
    money: money.toJSON(), plan
  };
}

async function prepare(actor: AccountActorContext, tx: TenantTransaction, intent: WorkOrderFinanceIntent) {
  const stamp = await maintenanceAuthorityStamp(actor, tx);
  const order = await findOrder(actor, tx, intent.taskId, "edit");
  const repository = new WorkOrderFinanceRepository(tx, actor.organizationId);
  const data = intent.kind === "estimate" ? await estimate(actor, tx, order, intent, repository) : null;
  let source = null;
  if (intent.kind !== "estimate") {
    await verifyFinance(actor, tx, order, "create");
    source = await readEvidence(actor, tx, order, intent.kind, intent.sourceId);
    const previous = await repository.linkedSource(intent.kind, intent.sourceId);
    if (previous && (previous.taskId !== intent.taskId || previous.sourceVersion === source.version))
      throw new WorkOrderConflictError();
  }
  const detail = data?.detail ?? { kind: intent.kind, source };
  const money = data?.money ?? source.money;
  const fingerprint = jsonbFingerprint({ stamp, source: order.fingerprint, intent, detail, policy: data?.plan.snapshot });
  await order.recheck();
  if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
  return { authorizationStamp: stamp, fingerprint, detail, money, plan: data?.plan, source, order };
}

export async function previewWorkOrderFinance(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = actorFor(context), intent = workOrderFinanceIntentSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx =>
    workOrderFinanceReviewSchema.parse(await prepare(actor, tx, intent)));
}

export async function publishWorkOrderFinance(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = actorFor(context), command = workOrderFinanceCommandSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const { intent } = command;
    const repository = new WorkOrderFinanceRepository(tx, actor.organizationId);
    const orders = new WorkOrderRepository(tx, actor.organizationId);
    await repository.lockNonce(actor.actorId, command.idempotencyKey);
    const previous = await repository.byNonce(actor.actorId, command.idempotencyKey);
    const requestHash = jsonbFingerprint(command);
    if (previous) {
      if (previous.requestHash !== requestHash) throw new WorkOrderConflictError();
      return { recorded: true };
    }
    await orders.lockTask(intent.taskId);
    if (intent.kind !== "estimate") await lockWorkOrderFinancialSource(tx, actor.organizationId, intent.kind, intent.sourceId);
    const data = await prepare(actor, tx, intent);
    if (data.fingerprint !== command.fingerprint) throw new WorkOrderConflictError();
    const record = await repository.record({
      taskId: intent.taskId, actorId: actor.actorId, idempotencyKey: command.idempotencyKey, requestHash,
      estimateRevision: intent.kind === "estimate" ? intent.expectedRevision + 1 : null,
      expenseId: intent.kind === "expense" ? intent.sourceId : null, invoiceId: intent.kind === "invoice" ? intent.sourceId : null,
      sourceVersion: data.source?.version, amount: data.money.amount, currency: data.money.currency,
      reason: intent.reason, snapshot: JSON.parse(JSON.stringify({ detail: data.detail, policy: data.plan?.snapshot })) as Prisma.InputJsonObject
    });
    await writeAuditEvent(tx, {
      organizationId: actor.organizationId, actorId: actor.actorId, action: "maintenance.work_order.finance.recorded",
      resourceType: "maintenance_work_order", resourceId: intent.taskId, propertyScopeId: data.order.task.task.propertyId,
      after: { kind: intent.kind, recordId: record.id }, requestId: deps.requestId ?? randomUUID(), occurredAt: record.createdAt
    });
    if (intent.kind === "estimate" && data.plan?.stages.length) {
      const approvals = new ApprovalRepository(tx, actor.organizationId);
      const approval = await approvals.createFinancial({
        maintenanceEstimateId: record.id, propertyId: data.order.task.task.propertyId, requestedBy: actor.actorId,
        title: intent.fields.purpose.slice(0, 160), details: intent.fields.purpose, stages: data.plan.stages
      });
      if (!approval) throw new WorkOrderConflictError();
      await approvals.event("ApprovalRequested", approval.id, approval.propertyId);
      await new NotificationRepository(tx, actor.organizationId).publish(
        { kind: "approval_requested", recipientId: actor.actorId, targetId: approval.id },
        "approval:" + approval.id + ":stage:" + approval.financialStages[0].id + ":requested"
      );
    }
    await data.order.recheck();
    await verifyFinance(actor, tx, data.order, "create", intent.kind === "estimate" ? intent.fields : undefined);
    if (data.authorizationStamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return { recorded: true };
  });
}

const historyInput = z.object({ taskId: z.uuid(), cursor: z.string().max(6000).optional() }).strict();
export async function readWorkOrderFinance(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = actorFor(context), input = historyInput.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const order = await findOrder(actor, tx, input.taskId);
    await verifyFinance(actor, tx, order, "view");
    const repository = new WorkOrderFinanceRepository(tx, actor.organizationId);
    const filter = jsonbFingerprint({ purpose: "MAINTENANCE_FINANCE", task: input.taskId, stamp, scope: authorizationScopeStamp(actor.authContext) });
    const before = readMaintenanceSourceCursor(actor, filter, input.cursor);
    const [rows, latest] = await Promise.all([repository.history(input.taskId, before), repository.latestEstimate(input.taskId)]);
    const reviews = await new ApprovalRepository(tx, actor.organizationId).maintenanceReviews(
      rows.flatMap(row => row.estimateRevision !== null ? [row.id] : [])
    );
    let canWrite = false;
    try {
      await findOrder(actor, tx, input.taskId, "edit");
      await verifyFinance(actor, tx, order, "create");
      canWrite = true;
    } catch (error) {
      if (!(error instanceof WorkOrderAccessError)) throw error;
    }
    const items = [];
    for (const row of rows.slice(0, 20)) {
      try {
        let detail;
        if (row.estimateRevision !== null) {
          const snapshot = z.object({ detail: estimateSnapshotSchema }).parse(row.snapshot).detail;
          const { resource, now } = await verifyFinance(actor, tx, order, "view", {
            ...snapshot.fields, id: row.id, actorId: row.actorId
          });
          detail = present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { ...resource, data: {
            ...snapshot, kind: "estimate" as const, revision: row.estimateRevision, approval: reviews.get(row.id)
          } }, {}, now);
        } else {
          const kind = row.expenseId ? "expense" : "invoice";
          detail = { kind, source: await readEvidence(actor, tx, order, kind, (row.expenseId ?? row.invoiceId)!) };
        }
        items.push({ id: row.id, reason: row.reason, recordedAt: row.createdAt.toISOString(), detail,
          recordedMoney: Money.of(row.amount.toString(), row.currency).toJSON(), recordedSourceVersion: row.sourceVersion });
      } catch (error) {
        if (!(error instanceof WorkOrderAccessError)) throw error;
        items.push({ masked: true });
      }
    }
    await order.recheck();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return workOrderFinanceHistorySchema.parse({
      authorizationStamp: stamp, latestRevision: latest?.revision ?? 0,
      canEstimate: canWrite && latest?.approvalState !== "PENDING", canLink: canWrite, items,
      next: rows.length > 20 ? maintenanceSourceCursor(actor, filter, rows[19].id) : null
    });
  });
}

export async function searchWorkOrderFinance(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = actorFor(context), input = workOrderFinanceSearchSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const order = await findOrder(actor, tx, input.taskId, "edit");
    await verifyFinance(actor, tx, order, "create");
    const repository = new WorkOrderFinanceRepository(tx, actor.organizationId);
    const filter = jsonbFingerprint({ purpose: "MAINTENANCE_FINANCE_CHOICES", ...input, cursor: undefined,
      stamp, scope: authorizationScopeStamp(actor.authContext) });
    const before = readMaintenanceSourceCursor(actor, filter, input.cursor);
    const rows = await repository.sourceChoices(input.kind, order.task.task.propertyId, input.query, before);
    const items = [];
    for (const row of rows.slice(0, 20)) {
      try {
        const source = await readEvidence(actor, tx, order, input.kind, row.id);
        const prior = await repository.linkedSource(input.kind, row.id);
        if (!prior || (prior.taskId === input.taskId && prior.sourceVersion !== source.version)) items.push(source);
      } catch (error) {
        if (!(error instanceof WorkOrderAccessError)) throw error;
      }
    }
    await order.recheck();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return workOrderFinanceChoicesSchema.parse({ authorizationStamp: stamp, items,
      next: rows.length > 20 ? maintenanceSourceCursor(actor, filter, rows[19].id) : null });
  });
}

const statusInput = z.object({ taskId: z.uuid(), idempotencyKey: z.uuid() }).strict();
export async function workOrderFinanceStatus(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = actorFor(context), input = statusInput.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new WorkOrderFinanceRepository(tx, actor.organizationId);
    await repository.lockNonce(actor.actorId, input.idempotencyKey);
    const order = await findOrder(actor, tx, input.taskId);
    await verifyFinance(actor, tx, order, "view");
    const record = await repository.byNonce(actor.actorId, input.idempotencyKey);
    if (record && record.taskId !== input.taskId) throw new WorkOrderAccessError();
    await order.recheck();
    return { recorded: Boolean(record) };
  });
}
