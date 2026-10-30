import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { ExpenseRepository } from "@/modules/finance/infrastructure/expense-repository";
import { SupplierInvoiceRepository } from "@/modules/finance/infrastructure/supplier-invoice-repository";
import { EmployeeCompensationRunRepository } from "@/modules/finance/infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationClaimRepository } from "@/modules/finance/infrastructure/employee-compensation-claim-repository";
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
  const employee=row.employeeSubmission;
  if ((!row.expense && !invoice&&!employee) || !stage) throw new ApprovalAccessError();
  const source = row.expense ?? invoice??{id:employee!.id,state:employee!.withdrawal?"CANCELLED":row.state==="PENDING"?"PENDING_APPROVAL":row.state};
  const invoiceSource = Boolean(invoice),lineSource=invoiceSource||Boolean(employee), resourceType = employee?"employee_compensation_submission":invoiceSource ? "supplier_invoice" : "expense";
  const now = await assertFinancialDecision(actor, row, stage, action, tx, repository);
  if (stage.state !== "PENDING") {
    if (stage.state === input.decision && stage.decidedBy === actor.accountId && stage.decisionReason === input.reason) return;
    throw new ApprovalConflictError();
  }
  if (row.state !== "PENDING" || source.state !== "PENDING_APPROVAL" || (invoice && invoice.currentSubmissionId !== row.invoiceSubmissionId) ||
    row.financialStages.find(stage => stage.state === "PENDING")?.id !== stage.id) throw new ApprovalConflictError();
  if ((await repository.decideStage(stage.id, input.decision, actor.accountId, input.reason, now)).count !== 1) throw new ApprovalConflictError();
  await assertFinancialDecision(actor, row, stage, action, tx, repository);
  await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: employee?"finance.employee_compensation.approval_stage_decided":invoiceSource ? "finance.supplier_invoice.approval_stage_decided" : "expense.approval_stage_decided", resourceType,
    resourceId: source.id, propertyScopeId: lineSource ? stage.propertyId : row.propertyId, before: { stageId: stage.id, position: stage.position, state: stage.state },
    after: { stageId: stage.id, position: stage.position, state: input.decision, amount: (lineSource ? stage.amount : row.expense!.amount).toFixed(2),
      currency: lineSource ? stage.currency : row.expense!.currency, ...(lineSource ? { lineId: employee?stage.employeeCostId:stage.invoiceLineId } : {}) },
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
  const changed = employee?{count:1}:invoice ? await new SupplierInvoiceRepository(tx, actor.organizationId).transitionReview(invoice.id, invoice.version, input.decision, actor.accountId) :
    await new ExpenseRepository(tx, actor.organizationId).transition(row.expense!.id, row.expense!.version, "PENDING_APPROVAL", input.decision, actor.accountId);
  if (changed.count !== 1) throw new ApprovalConflictError();
  await repository.event("ApprovalDecided", row.id, row.propertyId);
  await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.accountId, action: employee?`finance.employee_compensation.${input.decision.toLowerCase()}`:invoiceSource ?
    (input.decision === "APPROVED" ? "finance.supplier_invoice.approved" : "finance.supplier_invoice.rejected") : (input.decision === "APPROVED" ? "expense.approved" : "expense.rejected"),
    resourceType, resourceId: source.id, propertyScopeId: row.propertyId, before: { state: source.state, ...(invoice ? { version: invoice.version } : {}) },
    after: { state: input.decision, approvalId: row.id, ...(invoice ? { version: invoice.version + 1, revisionId: invoice.currentRevisionId, submissionId: row.invoiceSubmissionId } : {}) },
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
    const financial = Boolean(row.expenseId || row.invoiceSubmissionId||row.employeeSubmissionId),lineSource=Boolean(row.invoiceSubmissionId||row.employeeSubmissionId);
    const authorities = financial ? [actor.authContext, (await currentFinancialActor(actor, tx)).authContext] : [actor.authContext];
    const now = await repository.clock();
    const allowed = (action: "view" | "approve" | "reject", stage?: Approval["financialStages"][number]) =>
      authorities.every(authority => authorize(authority, action, approvalResource(row, stage?.ownerId, stage), now));
    const active = row.financialStages.find(stage => stage.state === "PENDING");
    const owned = row.financialStages.filter(stage => stage.recipients.some(recipient => recipient.userAccountId === actor.accountId) && allowed("view", stage));
    const own = lineSource ? (owned.find(stage => stage.id === active?.id) ?? owned.find(stage => stage.state === "PENDING") ?? owned.at(-1)) : owned[0];
    const fullInvoice = Boolean(row.invoiceSubmissionId && authorities.every(authority => authorizeOrganizationSource(authority, "view",
      { type: "supplier_invoice", organizationId: actor.organizationId, dataClass: "financial" }, now) && authorizeOrganizationSource(authority, "view",
      { type: "supplier", organizationId: actor.organizationId, dataClass: "personal" }, now)));
    const visibleStages = lineSource ? (fullInvoice ? row.financialStages.filter(stage => allowed("view", stage)) : owned) : [];
    const requested = deps.stageId ? visibleStages.find(stage => stage.id === deps.stageId) : undefined;
    if (deps.stageId && !requested) throw new ApprovalAccessError();
    const boundary = deps.afterStageId ? visibleStages.findIndex(stage => stage.id === deps.afterStageId) : -1;
    if (deps.afterStageId && boundary < 0) throw new ApprovalAccessError();
    const history = visibleStages.slice(boundary + 1, boundary + 52);
    const shown = lineSource ? (requested ?? own ?? (fullInvoice ? active ?? row.financialStages.at(-1) : undefined)) : own ?? active;
    if (lineSource && !shown) throw new ApprovalAccessError();
    const source = approvalResource(row, shown?.ownerId, shown);
    if (!await new NotificationRepository(tx, actor.organizationId).activeRecipient(actor.accountId) || !allowed("view", shown)) throw new ApprovalAccessError();
    const selected = financial ? Boolean(active?.recipients.some(recipient => recipient.userAccountId === actor.accountId)) : row.recipients.some((recipient) => recipient.userAccountId === actor.accountId);
    const line = lineSource ? invoiceApprovalSourceSnapshotSchema.parse(shown!.sourceSnapshot) : null;
    const data = { id: row.id, propertyName: row.property?.name ?? shown?.property?.name ?? null,
      title: line ? line.note.slice(0,160) : row.title, details: line?.note ?? row.details,
      state:row.employeeSubmission?.withdrawal?"CANCELLED":line && (!fullInvoice || requested) ? shown!.state : row.state, decisionReason: line && (!fullInvoice || requested) ? (shown!.state === "CANCELLED" ? null : shown!.decisionReason) : row.decisionReason,
      financial: row.expense ? { amount: row.expense.amount.toFixed(2), currency: row.expense.currency, category: row.expense.category, occurredOn: row.expense.occurredOn.toISOString().slice(0,10) } :
        line ? { amount: shown!.amount.toFixed(2), currency: shown!.currency, category: line.category, occurredOn: line.occurredOn } : null,
      stageId: lineSource ? shown?.id : active?.id,
      history: history.slice(0, 50).map(stage => ({ id: stage.id, note: invoiceApprovalSourceSnapshotSchema.parse(stage.sourceSnapshot).note,
        state: stage.state, amount: stage.amount.toFixed(2), currency: stage.currency })),
      historyNext: history.length > 50 ? history[49].id : undefined,
      canApprove: !row.employeeSubmission?.withdrawal&&row.state === "PENDING" && selected && (!lineSource || shown?.id === active?.id) && allowed("approve", active),
      canReject: !row.employeeSubmission?.withdrawal&&row.state === "PENDING" && selected && (!lineSource || shown?.id === active?.id) && allowed("reject", active) };
    if(financial)await recheckFinanceAuthorization({organizationId:actor.organizationId,actorId:actor.accountId,authContext:actor.authContext},tx,await repository.clock(),[{action:"view",resource:source}],new ApprovalAccessError());
    return present({ ...actor.authContext, visibleDataClasses: new Set() }, "view", { ...source, data }, {}) as typeof data;
  });
}
export async function decideApproval(actor: NotificationActor, raw: unknown, deps: Deps = {}) {
  const input = approvalDecisionSchema.parse(raw); assertActor(actor);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repository = new ApprovalRepository(tx, actor.organizationId);
    const initial = await repository.find(input.id);
    if (initial?.expenseId) await repository.lockExpense(initial.expenseId);
    if (initial?.invoiceSubmission) await repository.lockInvoice(initial.invoiceSubmission.invoice.id);
    if(initial?.employeeSubmission){await new EmployeeCompensationRunRepository(tx,actor.organizationId).lock(initial.employeeSubmission.runId);await new EmployeeCompensationClaimRepository(tx,actor.organizationId).lock(initial.employeeSubmission.id);}
    const row = await repository.find(input.id, true);
    if (row?.expenseId || row?.invoiceSubmissionId||row?.employeeSubmissionId) return decideFinancial(actor, input, row, tx, repository, deps);
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
