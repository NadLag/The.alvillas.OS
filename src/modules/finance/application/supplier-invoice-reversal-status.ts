import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { Money } from "@/platform/money/money";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { SupplierInvoiceRecognitionRequestRepository } from "../infrastructure/supplier-invoice-recognition-request-repository";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import type { FinanceActorContext } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError, supplierInvoiceOrganizationResource } from "./supplier-invoice-access";
import { inspectSupplierInvoiceSettlementSource, prepareSupplierInvoiceReversal } from "./supplier-payment-service";
import { supplierInvoiceFinancialStatusQuery, supplierInvoiceRequestHistory } from "./supplier-invoice-request-history";

/** Protect every original cost and every actual contributing movement before disclosing cancellation status. */
export async function getSupplierInvoiceReversalStatus(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner } = {}) {
  const input = supplierInvoiceFinancialStatusQuery.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const source = await inspectSupplierInvoiceSettlementSource(ctx, input.id, tx), requests = new SupplierInvoiceRecognitionRequestRepository(tx, ctx.organizationId);
    const history = await requests.history(input.id, input.before, "REVERSE"), pending = await requests.pending(input.id, "REVERSE");
    const originals = new Set(source.existing!.lines.map(line => line.transactionId));
    const reversed = source.journals.some(journal => originals.has(journal.id) && journal.reversedByTransactions.length > 0);
    const paymentsActive = source.journals.some(journal => !journal.reversesTransactionId && journal.postings.some(posting => posting.bucket === "SUPPLIER_PAYMENT") && !journal.reversedByTransactions.length);
    const periods = new AccountingPeriodRepository(tx, ctx.organizationId), now = await source.finance.clock(), calendar = await periods.policy(now);
    const postingOpen = await periods.postingOpen(now);
    let canRequest = false;
    if (calendar && !reversed && !pending && !paymentsActive && postingOpen) {
      try {
        await prepareSupplierInvoiceReversal(ctx, { id: input.id, expectedVersion: source.row.version, idempotencyKey: crypto.randomUUID(),
          reason: "Inspect current complete supplier claim cancellation authority" }, tx);
        canRequest = true;
      } catch (error) {
        if (!(error instanceof SupplierInvoiceAccessError || error instanceof SupplierInvoiceConflictError || error instanceof AccountingPeriodClosedError)) throw error;
      }
    }
    const result = { id: input.id, version: source.row.version, reversed, pending: Boolean(pending), canRequest, paymentsActive, postingOpen,
      amount: Money.of(source.revision.amount.toString(), source.revision.currency).toJSON(), sourceCosts: source.costs.length,
      timezone: calendar?.value.timezone ?? "UTC", ...supplierInvoiceRequestHistory(history) };
    await source.recheckSettlement(await source.finance.clock());
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...supplierInvoiceOrganizationResource(ctx.organizationId), data: result },
      catalogFieldPolicy<typeof result>("supplier_invoice"), await source.finance.clock()) as typeof result;
  }, { timeout: 120000 });
}
