import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { ExpenseRepository } from "@/modules/finance/infrastructure/expense-repository";
import { OwnerPayoutRepository } from "@/modules/finance/infrastructure/owner-payout-repository";
import { ownerPayoutCapacity } from "@/modules/finance/application/owner-payout-policy";
import { Money } from "@/platform/money/money";
import { SupplierInvoiceRepository } from "@/modules/finance/infrastructure/supplier-invoice-repository";
import { recheckFinanceAuthorization } from "@/modules/finance/application/finance-access";
import { authorize } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import type { NotificationActor } from "@/platform/notifications/notification-service";
import { ApprovalRepository } from "./approval-repository";
import { ApprovalAccessError, ApprovalConflictError, approvalDecisionSchema, approvalRequestSchema, approvalResource, invoiceApprovalSourceSnapshotSchema } from "./approval";

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
  const resource = approvalResource(row, stage.ownerId, stage);
  await recheckFinanceAuthorization({ organizationId: actor.organizationId, actorId: actor.accountId, authContext: actor.authContext }, tx, now,
    [{ action: "view", resource }, { action, resource }], new ApprovalAccessError());
  return now;
}
async function decideFinancial(actor: NotificationActor, input: z.infer<typeof approvalDecisionSchema>, row: Approval,
  tx: TenantTransaction, repository: ApprovalRepository, deps: Deps) {
  const stage = row.financialStages.find(stage => stage.id === input.stageId), action = input.decision === "APPROVED" ? "approve" : "reject";
  const invoice = row.invoiceSubmission?.invoice;
  if ((!row.expense && !row.payout && !invoice) || !stage) throw new ApprovalAccessError();
  const source = row.expense ?? row.payout ?? invoice!;
  const invoiceSource = Boolean(invoice), resourceType = invoiceSource ? "supplier_invoice" : row.payout ? "owner_payout" : "expense";
  const now = await assertFinancialDecision(actor, row, stage, action, tx, repository);
  if (stage.state !== "PENDING") {
    if (stage.state === input.decision && stage.decidedBy === actor.accountId && stage.decisionReason === input.reason) return;
    throw new ApprovalConflictError();
  }
  if (row.state !== "PENDING" || source.state !== "PENDING_APPROVAL" || (invoice && invoice.currentSubmissionId !== row.invoiceSubmissionId) ||
    row.financialStages.find(stage => stage.state === "PENDING")?.id !== stage.id) throw new ApprovalConflictError();
  if ((await repository.decideStage(stage.id, input.decision, actor.accountId, input.reason, now)).count !== 1) throw new ApprovalConflictError();
  await assertFinancialDecision(actor, row, stage, action, tx, repository);
  await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: invoiceSource ? "finance.supplier_invoice.approval_stage_decided" : row.payout ? "finance.owner_payout.approval_stage_decided" : "expense.approval_stage_decided", resourceType,
    resourceId: source.id, propertyScopeId: invoiceSource ? stage.propertyId : row.propertyId, before: { stageId: stage.id, position: stage.position, state: stage.state },
    after: { stageId: stage.id, position: stage.position, state: input.decision, amount: (invoiceSource ? stage.amount : (row.expense ?? row.payout)!.amount).toFixed(2),
      currency: invoiceSource ? stage.currency : (row.expense ?? row.payout)!.currency, ...(invoiceSource ? { lineId: stage.invoiceLineId } : {}) },
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
  const state = row.payout && input.decision==="REJECTED" ? "CANCELLED" : input.decision;
  if(row.payout){
    const payouts=new OwnerPayoutRepository(tx,actor.organizationId),payout=await payouts.find(row.payout.id);
    if(!payout)throw new ApprovalConflictError();
    if(input.decision==="APPROVED"){
      const frozen=z.object({payout:z.object({holdbackAmount:z.object({amount:z.string(),currency:z.literal(payout.currency)})})}).parse(payout.policySnapshot);
      const capacity=await ownerPayoutCapacity({organizationId:actor.organizationId,actorId:actor.accountId,authContext:actor.authContext},payout,tx,now);
      if(Money.of(payout.amount.toString(),payout.currency).amount.gt(capacity.balance.subtract(capacity.committed).subtract(Money.of(frozen.payout.holdbackAmount.amount,payout.currency)).amount))throw new ApprovalConflictError();
    }
    if((await payouts.transition(payout.id,payout.version,"PENDING_APPROVAL",input.decision==="APPROVED"?"APPROVED":"CANCELLED",actor.accountId,
      input.decision==="APPROVED"?{approvedAt:now}:{})).count!==1)throw new ApprovalConflictError();
  } else {
    const changed = invoice ? await new SupplierInvoiceRepository(tx, actor.organizationId).transitionReview(invoice.id, invoice.version, input.decision, actor.accountId) :
      await new ExpenseRepository(tx, actor.organizationId).transition(row.expense!.id, row.expense!.version, "PENDING_APPROVAL", input.decision, actor.accountId);
    if (changed.count !== 1) throw new ApprovalConflictError();
  }
  await repository.event("ApprovalDecided", row.id, row.propertyId);
  await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: invoiceSource ?
    (input.decision === "APPROVED" ? "finance.supplier_invoice.approved" : "finance.supplier_invoice.rejected") : row.payout ? (input.decision === "APPROVED" ? "finance.owner_payout.approved" : "finance.owner_payout.cancelled") : (input.decision === "APPROVED" ? "expense.approved" : "expense.rejected"),
    resourceType, resourceId: source.id, propertyScopeId: row.propertyId, before: { state: source.state, version: source.version },
    after: { state, version: source.version + 1, approvalId: row.id, ...(row.payout ? { payoutId: row.payout.id } : {}), ...(invoice ? { revisionId: invoice.currentRevisionId, submissionId: row.invoiceSubmissionId } : {}) },
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
export async function getApproval(actor: NotificationActor, id: string, deps: Deps & { stageId?: string; afterStageId?: string } = {}) {
  z.string().uuid().parse(id); assertActor(actor);
  if (deps.stageId) z.uuid().parse(deps.stageId);
  if (deps.afterStageId) z.uuid().parse(deps.afterStageId);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId), row = await repository.find(id);
    if (!row) throw new ApprovalAccessError();
    const financial = Boolean(row.expenseId || row.payoutId || row.invoiceSubmissionId);
    const authorities = financial ? [actor.authContext, (await currentFinancialActor(actor, tx)).authContext] : [actor.authContext];
    const now = await repository.clock();
    const allowed = (action: "view" | "approve" | "reject", stage?: Approval["financialStages"][number]) =>
      authorities.every(authority => authorize(authority, action, approvalResource(row, stage?.ownerId, stage), now));
    const active = row.financialStages.find(stage => stage.state === "PENDING");
    const owned = row.financialStages.filter(stage => stage.recipients.some(recipient => recipient.userAccountId === actor.accountId) && allowed("view", stage));
    const own = row.invoiceSubmissionId ? (owned.find(stage => stage.id === active?.id) ?? owned.find(stage => stage.state === "PENDING") ?? owned.at(-1)) : owned[0];
    const fullInvoice = Boolean(row.invoiceSubmissionId && authorities.every(authority => authorizeOrganizationSource(authority, "view",
      { type: "supplier_invoice", organizationId: actor.organizationId, dataClass: "financial" }, now) && authorizeOrganizationSource(authority, "view",
      { type: "supplier", organizationId: actor.organizationId, dataClass: "personal" }, now)));
    const visibleStages = row.invoiceSubmissionId ? (fullInvoice ? row.financialStages.filter(stage => allowed("view", stage)) : owned) : [];
    const requested = deps.stageId ? visibleStages.find(stage => stage.id === deps.stageId) : undefined;
    if (deps.stageId && !requested) throw new ApprovalAccessError();
    const boundary = deps.afterStageId ? visibleStages.findIndex(stage => stage.id === deps.afterStageId) : -1;
    if (deps.afterStageId && boundary < 0) throw new ApprovalAccessError();
    const history = visibleStages.slice(boundary + 1, boundary + 52);
    const shown = row.invoiceSubmissionId ? (requested ?? own ?? (fullInvoice ? active ?? row.financialStages.at(-1) : undefined)) : own ?? active;
    if (row.invoiceSubmissionId && !shown) throw new ApprovalAccessError();
    const source = approvalResource(row, shown?.ownerId, shown);
    if (!await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId) || !allowed("view", shown)) throw new ApprovalAccessError();
    const selected = financial ? Boolean(active?.recipients.some(recipient => recipient.userAccountId === actor.accountId)) : row.recipients.some((recipient) => recipient.userAccountId === actor.accountId);
    const line = row.invoiceSubmissionId ? invoiceApprovalSourceSnapshotSchema.parse(shown!.sourceSnapshot) : null;
    const data = { id: row.id, propertyName: row.property?.name ?? shown?.property?.name ?? null,
      title: line ? line.note.slice(0,160) : row.title, details: line?.note ?? row.details,
      state: line && (!fullInvoice || requested) ? shown!.state : row.state, decisionReason: line && (!fullInvoice || requested) ? (shown!.state === "CANCELLED" ? null : shown!.decisionReason) : row.decisionReason,
      financial: row.expense ? { amount: row.expense.amount.toFixed(2), currency: row.expense.currency, category: row.expense.category, occurredOn: row.expense.occurredOn.toISOString().slice(0,10) } :
        row.payout ? { amount: row.payout.amount.toFixed(2), currency: row.payout.currency, category: "owner_payout", occurredOn: row.payout.createdAt.toISOString().slice(0,10) } : line ? { amount: shown!.amount.toFixed(2), currency: shown!.currency, category: line.category, occurredOn: line.occurredOn } : null,
      stageId: row.invoiceSubmissionId ? shown?.id : active?.id,
      history: history.slice(0, 50).map(stage => ({ id: stage.id, note: invoiceApprovalSourceSnapshotSchema.parse(stage.sourceSnapshot).note,
        state: stage.state, amount: stage.amount.toFixed(2), currency: stage.currency })),
      historyNext: history.length > 50 ? history[49].id : undefined,
      canApprove: row.state === "PENDING" && selected && (!row.invoiceSubmissionId || shown?.id === active?.id) && allowed("approve", active),
      canReject: row.state === "PENDING" && selected && (!row.invoiceSubmissionId || shown?.id === active?.id) && allowed("reject", active) };
    return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { ...source, data }, {}) as typeof data;
  });
}
export async function decideApproval(actor: NotificationActor, raw: unknown, deps: Deps = {}) {
  const input = approvalDecisionSchema.parse(raw); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId);
    const initial = await repository.find(input.id);
    if (initial?.expenseId) await repository.lockExpense(initial.expenseId);
    if(initial?.payout){
      const payouts=new OwnerPayoutRepository(tx,actor.organizationId);
      await payouts.lockOwner(initial.payout.ownerId,initial.payout.propertyId,initial.payout.currency);
      await payouts.lock(initial.payout.id);
    }
    if (initial?.invoiceSubmission) await repository.lockInvoice(initial.invoiceSubmission.invoice.id);
    const row = await repository.find(input.id, true);
    if (row?.expenseId || row?.payoutId || row?.invoiceSubmissionId) return decideFinancial(actor, input, row, tx, repository, deps);
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
