import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { approvalResource, invoiceApprovalSourceSnapshotSchema } from "@/platform/approvals/approval";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierRepository } from "../infrastructure/supplier-repository";
import { SupplierInvoiceRepository, type SupplierInvoiceRecord } from "../infrastructure/supplier-invoice-repository";
import { supplierInvoiceCostResource } from "../domain/supplier-invoice";
import { assertSupplierInvoiceAuthority, SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { prepareSupplierInvoicePolicy, supplierInvoicePolicyInput } from "./supplier-invoice-policy";
import type { FinanceActorContext } from "./finance-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";

const normalizedId = z.uuid().transform(value => value.toLowerCase());
export const supplierInvoiceSubmissionInput = supplierInvoicePolicyInput.extend({ idempotencyKey: normalizedId,
  reason: z.string().trim().min(6).max(500), lineNotes: z.record(z.uuid(), z.string().trim().min(6).max(1000))
    .refine(notes => new Set(Object.keys(notes).map(key => key.toLowerCase())).size === Object.keys(notes).length, "Actual invoice line notes must be distinct")
    .transform(notes => Object.fromEntries(Object.entries(notes).map(([key, value]) => [key.toLowerCase(), value]))) }).strict();
type Deps = { db?: TenantTransactionRunner; requestId?: string };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;

async function recheckPriorSource(ctx: FinanceActorContext, row: SupplierInvoiceRecord,
  source: NonNullable<Awaited<ReturnType<SupplierInvoiceRepository["submissionByKey"]>>>, tx: TenantTransaction) {
  const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), revision = await repository.revision(row.id, source.revisionId);
  const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await assertSupplierInvoiceAuthority(ctx, tx, "edit", now);
  const snapshot = z.object({ lines: z.array(z.object({ id: z.uuid(), policy: z.object({ timezone: z.string() }) })) }).parse(source.snapshot);
  if (!revision || source.invoiceId !== row.id) throw new SupplierInvoiceAccessError();
  for (const line of revision.lines) {
    const policy = snapshot.lines.find(policy => policy.id === line.id);
    if (!policy) throw new SupplierInvoiceAccessError();
    const target = supplierInvoiceCostResource(ctx.organizationId, row, line, Money.of(line.amount.toString(), line.currency), source.occurredOn.toISOString().slice(0,10), policy.policy.timezone);
    const financial = { ...target, type: "financial_transaction", id: undefined, financialRecordId: undefined };
    if ([ctx.authContext, current].some(authority => line.propertyId ? !authorize(authority, "view", financial, now) :
      !authorizeOrganizationSource(authority, "view", financial, now))) throw new SupplierInvoiceAccessError();
    if (line.reservationId && [ctx.authContext, current].some(authority => !authorize(authority, "view", { ...target, type: "reservation", id: line.reservationId!,
      financialRecordId: undefined, status: line.reservation?.status, assignedUserAccountId: line.reservation?.createdBy ?? undefined }, now))) throw new SupplierInvoiceAccessError();
  }
}

/** Submission freezes policy and review context; it never recognizes or pays the supplier claim. */
export async function submitSupplierInvoice(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = supplierInvoiceSubmissionInput.parse(raw);
  const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: ctx.actorId, ...input,
    lineNotes: Object.entries(input.lineNotes).sort(([a], [b]) => a.localeCompare(b)) })).digest("hex");
  try {
    return await withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
      const repository = new SupplierInvoiceRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
      await assertSupplierInvoiceAuthority(ctx, tx, "edit", await finance.clock());
      await repository.lock(input.id);
      const now = await finance.clock(); await assertSupplierInvoiceAuthority(ctx, tx, "edit", now);
      const row = await repository.find(input.id), previous = await repository.submissionByKey(input.idempotencyKey);
      if (!row) throw new SupplierInvoiceAccessError();
      if (previous) {
        if (previous.invoiceId !== row.id || previous.submittedBy !== ctx.actorId || previous.requestFingerprint !== fingerprint) throw new SupplierInvoiceConflictError();
        await recheckPriorSource(ctx, row, previous, tx);
        return { id: row.id, submissionId: previous.id, approvalId: previous.approval?.id ?? null, version: row.version,
          state: row.currentSubmissionId === previous.id ? row.state : previous.approval?.state ?? "APPROVED", idempotent: true };
      }
      if (row.archivedAt || row.supplier.archivedAt || !row.currentRevision) throw new SupplierInvoiceAccessError();
      if (row.state !== "DRAFT" || row.version !== input.expectedVersion) throw new SupplierInvoiceConflictError();
      const suppliers = new SupplierRepository(tx, ctx.organizationId); await suppliers.lock(row.supplierId);
      const supplier = await suppliers.find(row.supplierId); if (!supplier || supplier.archivedAt) throw new SupplierInvoiceAccessError();
      const currency = await repository.currency(row.currentRevision.currency);
      if (!currency || currency.minorUnit > 2 || row.currentRevision.lines.some(line => Money.of(line.amount.toString(), line.currency).amount.decimalPlaces() > currency.minorUnit))
        throw new z.ZodError([{ code: "custom", path: ["currency"], message: "Unsupported invoice currency or precision" }]);
      const ids = row.currentRevision.lines.map(line => line.id);
      if (Object.keys(input.lineNotes).length !== ids.length || ids.some(id => !input.lineNotes[id])) throw new SupplierInvoiceConflictError();
      const plan = await prepareSupplierInvoicePolicy(ctx, row, { id: input.id, expectedVersion: input.expectedVersion, occurredOn: input.occurredOn, emergency: input.emergency }, tx, await finance.clock());
      const prepared = z.object({ lines: z.array(z.object({ id: z.uuid(), policy: z.object({ timezone: z.string() }).passthrough() }).passthrough()) }).parse(plan.snapshot);
      const lines = prepared.lines.map(line => ({ ...line, approvalNote: input.lineNotes[line.id] }));
      const stages = plan.stages.map(stage => {
        const line = row.currentRevision!.lines.find(line => line.id === stage.lineId), frozen = prepared.lines.find(line => line.id === stage.lineId);
        if (!line || !frozen) throw new SupplierInvoiceConflictError();
        return { ...stage, sourceSnapshot: json(invoiceApprovalSourceSnapshotSchema.parse({ lineId: line.id, note: input.lineNotes[line.id], category: line.category,
          occurredOn: input.occurredOn, timezone: frozen.policy.timezone, createdBy: row.createdBy })) };
      });
      const snapshot = json({ ...plan.snapshot, lines, stages, reason: input.reason });
      const submittedAt = await finance.clock();
      const source = await repository.submit({ invoiceId: row.id, revisionId: row.currentRevision.id, sourceInvoiceVersion: row.version,
        occurredOn: input.occurredOn, emergency: input.emergency, reason: input.reason, snapshot, idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint, submittedBy: ctx.actorId, submittedAt });
      if ((await repository.startSubmission(row.id, row.version, source.id, ctx.actorId)).count !== 1) throw new SupplierInvoiceConflictError();
      await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.submitted", resourceType: "supplier_invoice", resourceId: row.id,
        before: { state: "DRAFT", version: row.version }, after: { state: "PENDING_APPROVAL", version: row.version + 1, revisionId: source.revisionId, submissionId: source.id },
        reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: submittedAt });
      let approvalId: string | null = null, state = "PENDING_APPROVAL", version = row.version + 1;
      if (stages.length) {
        const approvals = new ApprovalRepository(tx, ctx.organizationId), approval = await approvals.createFinancial({ invoiceSubmissionId: source.id, propertyId: null,
          requestedBy: ctx.actorId, title: row.currentRevision.purpose.slice(0,160), details: row.currentRevision.purpose.length >= 6 ? row.currentRevision.purpose : input.reason, stages });
        if (!approval) throw new SupplierInvoiceConflictError(); approvalId = approval.id;
        await approvals.event("ApprovalRequested", approval.id, null);
        await new NotificationRepository(tx, ctx.organizationId).publish({ kind: "approval_requested", recipientId: ctx.actorId, targetId: approval.id }, `approval:${approval.id}:stage:${approval.financialStages[0].id}:requested`);
      } else {
        if ((await repository.transitionReview(row.id, version, "APPROVED", ctx.actorId)).count !== 1) throw new SupplierInvoiceConflictError();
        state = "APPROVED"; version++;
        await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.approved_by_policy", resourceType: "supplier_invoice", resourceId: row.id,
          before: { state: "PENDING_APPROVAL", version: version - 1 }, after: { state, version, revisionId: source.revisionId, submissionId: source.id },
          reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await finance.clock() });
      }
      if (plan.postHocNotices.length) {
        const receipt = await new NotificationRepository(tx, ctx.organizationId).publishInvoiceEmergencyNotices(source.id, plan.postHocNotices);
        await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.emergency_owner_notified", resourceType: "supplier_invoice", resourceId: row.id,
          after: { submissionId: source.id, noticeCount: receipt.count, ownerApprovalBypassed: true }, reason: input.reason,
          requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await finance.clock() });
      }
      await repository.event("SupplierInvoiceSubmitted", row.id, source.id, submittedAt);
      await plan.recheckAuthorization();
      if (approvalId) {
        const approval = await new ApprovalRepository(tx, ctx.organizationId).find(approvalId);
        if (!approval || !await new NotificationRepository(tx, ctx.organizationId).financialApprovalAudiencesAvailable(approval.financialStages.map(stage => ({
          routing: notificationRoutingSchema.parse(stage.routingSnapshot), resource: approvalResource(approval, stage.ownerId, stage),
          recipients: stage.recipients.map(recipient => recipient.userAccountId) })))) throw new ExpensePolicyUnavailableError("Configured invoice approval has no current authorized recipient");
      }
      return { id: row.id, submissionId: source.id, approvalId, version, state, idempotent: false };
    }, { timeout: 120000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2025"].includes(error.code)) throw new SupplierInvoiceConflictError();
    throw error;
  }
}
