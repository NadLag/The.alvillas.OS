import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierInvoiceRepository } from "../infrastructure/supplier-invoice-repository";
import { SupplierRepository } from "../infrastructure/supplier-repository";
import { SupplierInvoiceRecognitionRepository } from "../infrastructure/supplier-invoice-recognition-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { AccountingPeriodAdjustmentRepository } from "../infrastructure/accounting-period-adjustment-repository";
import { supplierInvoiceRecognitionCosts } from "../domain/supplier-invoice-recognition";
import { supplierInvoicePostings } from "../domain/supplier-payable";
import { supplierInvoiceCostResource } from "../domain/supplier-invoice";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { assertSupplierInvoiceAuthority, SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";

export const supplierInvoiceRecognitionInput = z.object({ id: z.uuid().transform(value => value.toLowerCase()), expectedVersion: z.number().int().positive(),
  idempotencyKey: z.uuid().transform(value => value.toLowerCase()), reason: z.string().trim().min(6).max(500), currentPeriod: z.boolean().default(false) }).strict();

/** All actual approved costs become supplier claims atomically, without moving physical money. */
export async function recognizeSupplierInvoice(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const input = supplierInvoiceRecognitionInput.parse(raw), requestId = deps.requestId ?? crypto.randomUUID();
  const fingerprint = createHash("sha256").update(JSON.stringify({ actorId: ctx.actorId, ...input })).digest("hex");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const finance = new FinanceRepository(tx, ctx.organizationId), invoices = new SupplierInvoiceRepository(tx, ctx.organizationId),
      recognitions = new SupplierInvoiceRecognitionRepository(tx, ctx.organizationId), periods = new AccountingPeriodRepository(tx, ctx.organizationId);
    await assertSupplierInvoiceAuthority(ctx, tx, "pay", await finance.clock());
    await invoices.lock(input.id);
    const row = await invoices.find(input.id);
    if (!row?.currentRevision || !row.currentSubmission || row.state !== "APPROVED" || row.archivedAt || row.supplier.archivedAt ||
      row.currentSubmission.revisionId !== row.currentRevision.id) throw new SupplierInvoiceAccessError();
    const supplier = new SupplierRepository(tx, ctx.organizationId); await supplier.lock(row.supplierId);
    const source = row.currentSubmission, revision = row.currentRevision;
    const costs = supplierInvoiceRecognitionCosts({ organizationId: ctx.organizationId, invoiceId: row.id, revisionId: revision.id, supplierId: row.supplierId,
      sourceInvoiceVersion: source.sourceInvoiceVersion, occurredOn: source.occurredOn.toISOString().slice(0,10), amount: revision.amount.toString(), currency: revision.currency,
      lines: revision.lines.map(line => ({ ...line, amount: line.amount.toString() })) }, source.snapshot);
    const existing = await recognitions.byInvoice(row.id), sameKey = await recognitions.byKey(input.idempotencyKey);
    if (existing || sameKey) {
      if (!existing || sameKey?.id !== existing.id || existing.requestFingerprint !== fingerprint || existing.createdBy !== ctx.actorId) throw new SupplierInvoiceConflictError();
    } else if (row.version !== input.expectedVersion) throw new SupplierInvoiceConflictError();
    const postAt = new Map<string, Date>(), adjustments = new Map<string, NonNullable<Awaited<ReturnType<AccountingPeriodRepository["postingPeriod"]>>>>();
    const current = await finance.clock();
    if (existing) for (const line of existing.lines) postAt.set(line.invoiceLineId, line.transaction.occurredAt);
    else for (const cost of costs) {
      if (input.currentPeriod && !await periods.postingOpen(cost.sourceOccurredAt)) {
        const closed = await periods.postingPeriod(cost.sourceOccurredAt);
        if (!closed?.events[0]) throw new SupplierInvoiceConflictError();
        adjustments.set(cost.id, closed); postAt.set(cost.id, current);
      } else postAt.set(cost.id, cost.sourceOccurredAt);
    }
    if (!existing && input.currentPeriod && !adjustments.size) throw new SupplierInvoiceConflictError();
    const recheck = async (at: Date, checkedCosts = costs) => {
      await assertSupplierInvoiceAuthority(ctx, tx, "pay", at);
      const actual = await invoices.recognitionSource(row.id, checkedCosts.map(cost => cost.id)), actualSupplier = await supplier.find(row.supplierId);
      if (!actual || actual.version !== row.version || actual.currentSubmissionId !== source.id || actual.currentRevisionId !== revision.id || actual.state !== "APPROVED" ||
        actual.archivedAt || !actualSupplier || actualSupplier.archivedAt || !actual.currentRevision) throw new SupplierInvoiceAccessError();
      if (actual.currentSubmission?.approval) {
        const approval = await new ApprovalRepository(tx, ctx.organizationId).find(actual.currentSubmission.approval.id);
        if (!approval || approval.state !== "APPROVED" || approval.financialStages.some(stage => stage.state !== "APPROVED")) throw new SupplierInvoiceConflictError();
      }
      const reservations = await invoices.reservations([...new Set(checkedCosts.flatMap(cost => cost.reservationId ? [cost.reservationId] : []))]);
      const checks: Parameters<typeof recheckFinanceAuthorization>[3][number][] = [];
      for (const cost of checkedCosts) {
        const line = actual.currentRevision.lines.find(line => line.id === cost.id), postingAt = postAt.get(cost.id);
        if (!line || line.propertyId && (!line.property || line.property.archivedAt) || !postingAt) throw new SupplierInvoiceAccessError();
        const invoice = supplierInvoiceCostResource(ctx.organizationId, actual, line, Money.of(revision.amount.toString(), revision.currency), source.occurredOn.toISOString().slice(0,10), cost.timezone);
        const financial = { ...invoice, type: "financial_transaction", id: undefined, financialRecordId: undefined, amount: cost.amount.toJSON().amount };
        checks.push({ action: "view", resource: invoice, organizationOnly: !line.propertyId }, { action: "pay", resource: invoice, organizationOnly: !line.propertyId },
          { action: "view", resource: financial, organizationOnly: !line.propertyId },
          { action: "create", resource: { ...financial, occurredAt: postingAt }, organizationOnly: !line.propertyId });
        const adjustment = existing?.lines.find(link => link.invoiceLineId === cost.id)?.periodAdjustment;
        if (adjustments.has(cost.id) || adjustment) checks.push({ action: "override", resource: financial, organizationOnly: !line.propertyId });
        if (line.reservationId) {
          const reservation = reservations.find(reservation => reservation.id === line.reservationId);
          if (!reservation || reservation.propertyId !== line.propertyId) throw new SupplierInvoiceAccessError();
          checks.push({ action: "view", resource: { ...invoice, type: "reservation", id: reservation.id, financialRecordId: undefined,
            status: reservation.status, assignedUserAccountId: reservation.createdBy } });
        }
      }
      await recheckFinanceAuthorization(ctx, tx, at, checks, new SupplierInvoiceAccessError());
    };
    await recheck(await finance.clock());
    if (existing) {
      const identities = new Map(existing.lines.map(line => [line.invoiceLineId, line.transactionId]));
      const transactionIds = costs.map(cost => { const id = identities.get(cost.id); if (!id) throw new SupplierInvoiceConflictError(); return id; });
      return { id: row.id, recognitionId: existing.id, transactionIds, idempotent: true };
    }
    const currency = await invoices.currency(revision.currency);
    if (!currency || costs.some(cost => cost.amount.amount.decimalPlaces() > currency.minorUnit)) throw new ExpensePolicyUnavailableError("Invoice currency precision is unavailable");
    const accounts = new Map<string, string>();
    for (const [code, accountType, normalSide] of [["SUPPLIER_PAYABLE", "CLAIM_OWNERSHIP", "CREDIT"], ["OWNER_PAYABLE", "CLAIM_OWNERSHIP", "CREDIT"],
      ["ALVILLAS_EXPENSE", "ALVILLAS_OWN", "DEBIT"], ["GUEST_RECEIVABLE", "CLAIM_OWNERSHIP", "DEBIT"]] as const) {
      const needed = code === "SUPPLIER_PAYABLE" || costs.some(cost => (code === "OWNER_PAYABLE" ? cost.allocation.ownerAmount :
        code === "ALVILLAS_EXPENSE" ? cost.allocation.alvillasAmount : cost.allocation.guestAmount).amount.gt(0));
      if (!needed) continue;
      const account = await finance.ensureLedgerAccount({ code, name: code, accountType, normalSide });
      if (account.archivedAt || account.accountType !== accountType || account.normalSide !== normalSide) throw new ExpensePolicyUnavailableError("Invoice ledger account is unavailable");
      accounts.set(code, account.id);
    }
    const recognition = await recognitions.create({ invoiceId: row.id, submissionId: source.id, invoiceVersion: row.version, currentPeriod: input.currentPeriod,
      idempotencyKey: input.idempotencyKey, requestFingerprint: fingerprint, reason: input.reason, createdBy: ctx.actorId });
    const journalInputs = costs.map(cost => {
      const postings = supplierInvoicePostings({ invoiceId: row.id, supplierId: row.supplierId, liabilityAccountId: accounts.get("SUPPLIER_PAYABLE")!, amount: cost.amount,
        lines: [{ ...cost, ownerAccounts: new Map(cost.owners.map(owner => [owner.ownerId, accounts.get("OWNER_PAYABLE") ?? ""])),
          companyExpenseAccountId: accounts.get("ALVILLAS_EXPENSE") ?? "", guestReceivableAccountId: accounts.get("GUEST_RECEIVABLE") ?? "" }] });
      return { reference: `SUPPLIER-INVOICE:${row.id}:${cost.id}`, description: revision.purpose,
        occurredAt: postAt.get(cost.id)!, idempotencyKey: `supplier-invoice:${source.id}:${cost.id}:recognized`, createdBy: ctx.actorId, postings,
      };
    });
    const journals = await finance.createFinancialTransactions(journalInputs, recheck), transactionIds = journals.map(journal => journal.id);
    const links = await recognitions.lines(costs.map((cost,index) => ({ recognitionId: recognition.id, invoiceLineId: cost.id, transactionId: journals[index].id, sourceOccurredAt: cost.sourceOccurredAt })));
    await recheck(await finance.clock());
    const linksByCost = new Map(links.map(link => [link.invoiceLineId, link]));
    for (const [index,cost] of costs.entries()) {
      const journal = journals[index], link = linksByCost.get(cost.id);
      if (!link) throw new SupplierInvoiceConflictError();
      const closed = adjustments.get(cost.id);
      if (closed) {
        const adjustment = await new AccountingPeriodAdjustmentRepository(tx, ctx.organizationId).create({ invoiceRecognitionLineId: link.id, transactionId: journal.id,
          periodId: closed.id, periodEventId: closed.events[0].id, sourceOccurredAt: cost.sourceOccurredAt, reason: input.reason, createdBy: ctx.actorId });
        await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.period.adjustment_posted", resourceType: "financial_transaction",
          resourceId: journal.id, propertyScopeId: cost.propertyId, after: { adjustmentId: adjustment.id, invoiceRecognitionLineId: link.id, invoiceId: row.id, submissionId: source.id,
            transactionId: journal.id, sourcePeriodId: closed.id, sourcePeriodEventId: closed.events[0].id, sourceOccurredAt: cost.sourceOccurredAt.toISOString(), postedAt: journal.occurredAt.toISOString() },
          reason: input.reason, requestId, occurredAt: await finance.clock() });
      }
    }
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.recognized", resourceType: "supplier_invoice", resourceId: row.id,
      before: { state: row.state, version: row.version }, after: { recognitionId: recognition.id, submissionId: source.id, revisionId: revision.id, transactionIds,
        amount: Money.of(revision.amount.toString(), revision.currency).toJSON(), postingDateMode: input.currentPeriod ? "ADJUST_CLOSED_SOURCES" : "SOURCE_DATES" },
      reason: input.reason, requestId, occurredAt: await finance.clock() });
    await recognitions.flushGuards();
    await recheck(await finance.clock());
    return { id: row.id, recognitionId: recognition.id, transactionIds, idempotent: false };
  }, { timeout: 120000 });
}
