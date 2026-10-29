import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { ExpenseRepository } from "@/modules/finance/infrastructure/expense-repository";
import { recheckFinanceAuthorization } from "@/modules/finance/application/finance-access";
import { authorize } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import type { NotificationActor } from "@/platform/notifications/notification-service";
import { ApprovalRepository } from "./approval-repository";
import { ApprovalAccessError, ApprovalConflictError, approvalDecisionSchema, approvalRequestSchema, approvalResource } from "./approval";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Approval = NonNullable<Awaited<ReturnType<ApprovalRepository["find"]>>>;
async function currentFinancialActor(actor: NotificationActor, tx: TenantTransaction) {
  return { ...actor, authContext: await authContextForAccountInTransaction(tx, actor.organizationId, actor.accountId) };
}
async function assertFinancialDecision(actor: NotificationActor, row: Approval, stage: Approval["financialStages"][number],
  action: "approve" | "reject", tx: TenantTransaction, repository: ApprovalRepository) {
  const now = await repository.clock();
  if (!stage.recipients.some(recipient => recipient.userAccountId === actor.accountId) ||
    !await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId)) throw new ApprovalAccessError();
  const resource = approvalResource(row, stage.ownerId);
  await recheckFinanceAuthorization({ organizationId: actor.organizationId, actorId: actor.accountId, authContext: actor.authContext }, tx, now,
    [{ action: "view", resource }, { action, resource }], new ApprovalAccessError());
  return now;
}
async function decideFinancial(actor: NotificationActor, input: z.infer<typeof approvalDecisionSchema>, row: Approval,
  tx: TenantTransaction, repository: ApprovalRepository, deps: Deps) {
  const stage = row.financialStages.find(stage => stage.id === input.stageId), action = input.decision === "APPROVED" ? "approve" : "reject";
  if (!row.expense || !stage) throw new ApprovalAccessError();
  const now = await assertFinancialDecision(actor, row, stage, action, tx, repository);
  if (stage.state !== "PENDING") {
    if (stage.state === input.decision && stage.decidedBy === actor.accountId && stage.decisionReason === input.reason) return;
    throw new ApprovalConflictError();
  }
  if (row.state !== "PENDING" || row.expense.state !== "PENDING_APPROVAL" ||
    row.financialStages.find(stage => stage.state === "PENDING")?.id !== stage.id) throw new ApprovalConflictError();
  if ((await repository.decideStage(stage.id, input.decision, actor.accountId, input.reason, now)).count !== 1) throw new ApprovalConflictError();
  await assertFinancialDecision(actor, row, stage, action, tx, repository);
  await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "expense.approval_stage_decided", resourceType: "expense",
    resourceId: row.expense.id, propertyScopeId: row.propertyId, before: { stageId: stage.id, position: stage.position, state: stage.state },
    after: { stageId: stage.id, position: stage.position, state: input.decision, amount: row.expense.amount.toFixed(2), currency: row.expense.currency },
    reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
  const next = input.decision === "APPROVED" ? row.financialStages.find(candidate => candidate.state === "PENDING" && candidate.position > stage.position) : undefined;
  await repository.resolveNotifications(row.id, input.decision, now);
  if (next) {
    await new NotificationRepository(tx, actor.organizationId).publish({ kind: "approval_requested", recipientId: actor.accountId, targetId: row.id }, `approval:${row.id}:stage:${next.id}:requested`);
    await assertFinancialDecision(actor, row, stage, action, tx, repository);
    return;
  }
  for (const later of row.financialStages.filter(candidate => candidate.position > stage.position && candidate.state === "PENDING"))
    await repository.decideStage(later.id, "CANCELLED", actor.accountId, input.reason, now);
  await repository.decide(row.id, input.decision, actor.accountId, input.reason, now);
  if ((await new ExpenseRepository(tx, actor.organizationId).transition(row.expense.id, row.expense.version, "PENDING_APPROVAL", input.decision, actor.accountId)).count !== 1) throw new ApprovalConflictError();
  await repository.event("ApprovalDecided", row.id, row.propertyId);
  await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: input.decision === "APPROVED" ? "expense.approved" : "expense.rejected",
    resourceType: "expense", resourceId: row.expense.id, propertyScopeId: row.propertyId, before: { state: row.expense.state }, after: { state: input.decision, approvalId: row.id },
    reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
  await new NotificationRepository(tx, actor.organizationId).publish({ kind: "approval_decided", recipientId: row.requestedBy, targetId: row.id }, `approval:${row.id}:decided`);
  await assertFinancialDecision(actor, row, stage, action, tx, repository);
}
function assertActor(actor: NotificationActor) {
  if (actor.authContext.organizationId !== actor.organizationId || actor.authContext.userAccountId !== actor.accountId) throw new ApprovalAccessError();
}
export async function getApprovalProperty(actor: NotificationActor, id: string, deps: Deps = {}) {
  z.string().uuid().parse(id); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const property = await new ApprovalRepository(tx, actor.organizationId).property(id);
    if (!property || !authorize(actor.authContext, "view", { type: "property", organizationId: actor.organizationId, propertyId: id, region: property.regionId, city: property.cityId }) || !authorize(actor.authContext, "edit", { type: "property", organizationId: actor.organizationId, propertyId: id, region: property.regionId, city: property.cityId })) throw new ApprovalAccessError();
    return { id: property.id, name: property.name };
  });
}
export async function requestApproval(actor: NotificationActor, raw: unknown, deps: Deps = {}) {
  const input = approvalRequestSchema.parse(raw); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId);
    const notifications = new NotificationRepository(tx, actor.organizationId);
    const property = await repository.property(input.propertyId);
    if (!property || !await notifications.activeRecipient(actor.accountId) || !authorize(actor.authContext, "edit", { type: "property", organizationId: actor.organizationId, propertyId: property.id, region: property.regionId, city: property.cityId })) throw new ApprovalAccessError();
    await repository.lockKey(input.idempotencyKey);
    const existing = await repository.byKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestedBy !== actor.accountId || existing.propertyId !== input.propertyId || existing.title !== input.title || existing.details !== input.details) throw new ApprovalConflictError();
      return { id: existing.id };
    }
    const routing = await notifications.routing("approval_requested", property.id);
    const recipients = await notifications.approvers(routing, { type: "property", organizationId: actor.organizationId, propertyId: property.id, region: property.regionId, city: property.cityId, status: "PENDING" });
    // Fail closed: an unconfigured request must never strand work without an approver.
    if (!recipients.length) throw new ApprovalConflictError();
    const row = await repository.create(input, actor.accountId, routing, recipients);
    await repository.event("ApprovalRequested",row.id,property.id);
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: "approval.requested", resourceType: "approval", resourceId: row.id,
      propertyScopeId: property.id, before: null, after: { state: row.state, recipientIds: recipients }, reason: input.details, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: row.createdAt });
    await notifications.publish({ kind: "approval_requested", recipientId: actor.accountId, targetId: row.id }, `approval:${row.id}:requested`);
    return { id: row.id };
  });
}
export async function getApproval(actor: NotificationActor, id: string, deps: Deps = {}) {
  z.string().uuid().parse(id); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId), row = await repository.find(id);
    if (!row) throw new ApprovalAccessError();
    const authorities = row.expenseId ? [actor.authContext, (await currentFinancialActor(actor, tx)).authContext] : [actor.authContext];
    const now = await repository.clock();
    const allowed = (action: "view" | "approve" | "reject", ownerId?: string | null) =>
      authorities.every(authority => authorize(authority, action, approvalResource(row, ownerId), now));
    const active = row.financialStages.find(stage => stage.state === "PENDING");
    const own = row.financialStages.find(stage => stage.recipients.some(recipient => recipient.userAccountId === actor.accountId) && allowed("view", stage.ownerId));
    const source = approvalResource(row, own?.ownerId ?? active?.ownerId);
    if (!await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId) || !allowed("view", own?.ownerId ?? active?.ownerId)) throw new ApprovalAccessError();
    const selected = row.expenseId ? Boolean(active?.recipients.some(recipient => recipient.userAccountId === actor.accountId)) : row.recipients.some((recipient) => recipient.userAccountId === actor.accountId);
    const data = { id: row.id, propertyName: row.property.name, title: row.title, details: row.details, state: row.state, decisionReason: row.decisionReason,
      financial: row.expense ? { amount: row.expense.amount.toFixed(2), currency: row.expense.currency, category: row.expense.category, occurredOn: row.expense.occurredOn.toISOString().slice(0,10) } : null,
      stageId: active?.id,
      canApprove: row.state === "PENDING" && selected && allowed("approve", active?.ownerId),
      canReject: row.state === "PENDING" && selected && allowed("reject", active?.ownerId) };
    return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { ...source, data }, {}) as typeof data;
  });
}
export async function decideApproval(actor: NotificationActor, raw: unknown, deps: Deps = {}) {
  const input = approvalDecisionSchema.parse(raw); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId);
    const initial = await repository.find(input.id);
    if (initial?.expenseId) await repository.lockExpense(initial.expenseId);
    const row = await repository.find(input.id, true);
    if (row?.expenseId) return decideFinancial(actor, input, row, tx, repository, deps);
    const action = input.decision === "APPROVED" ? "approve" : "reject";
    if (!row || !await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId) || !row.recipients.some((recipient) => recipient.userAccountId === actor.accountId) || !authorize(actor.authContext, "view", approvalResource(row)) || !authorize(actor.authContext, action, approvalResource(row))) throw new ApprovalAccessError();
    if (row.state !== "PENDING") {
      if (row.state === input.decision && row.decidedBy === actor.accountId && row.decisionReason === input.reason) return;
      throw new ApprovalConflictError();
    }
    const now = new Date();
    await repository.decide(row.id, input.decision, actor.accountId, input.reason, now);
    await repository.event("ApprovalDecided",row.id,row.propertyId);
    await repository.resolveNotifications(row.id, input.decision, now);
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: input.decision === "APPROVED" ? "approval.approved" : "approval.rejected", resourceType: "approval", resourceId: row.id,
      propertyScopeId: row.propertyId, before: { state: row.state }, after: { state: input.decision }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await new NotificationRepository(tx, actor.organizationId).publish({ kind: "approval_decided", recipientId: row.requestedBy, targetId: row.id }, `approval:${row.id}:decided`);
  });
}
