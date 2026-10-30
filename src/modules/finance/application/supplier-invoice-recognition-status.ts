import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { SupplierInvoiceRecognitionRequestRepository } from "../infrastructure/supplier-invoice-recognition-request-repository";
import type { FinanceActorContext } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError, supplierInvoiceOrganizationResource } from "./supplier-invoice-access";
import { inspectSupplierInvoiceRecognitionSource, prepareSupplierInvoiceRecognition } from "./supplier-invoice-recognition";
import { supplierInvoiceFinancialStatusQuery, supplierInvoiceRequestHistory } from "./supplier-invoice-request-history";


/** Status requires all current source financial permissions, independently of invoice-header access. */
export async function getSupplierInvoiceRecognitionStatus(ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner } = {}) {
  const input = supplierInvoiceFinancialStatusQuery.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const source = await inspectSupplierInvoiceRecognitionSource(ctx, input.id, tx);
    const requests = new SupplierInvoiceRecognitionRequestRepository(tx, ctx.organizationId), periods = new AccountingPeriodRepository(tx, ctx.organizationId);
    const history = await requests.history(input.id, input.before), pending = await requests.pending(input.id);
    const instants = new Map(source.costs.map(cost => [cost.sourceOccurredAt.toISOString(), cost.sourceOccurredAt]));
    const closed = new Set<string>();
    for (const [key, date] of instants) if (!await periods.postingOpen(date)) closed.add(key);
    let canRequest = false, currentPeriod = false;
    if (!source.existing && !pending) {
      currentPeriod = closed.size > 0;
      try {
        await prepareSupplierInvoiceRecognition(ctx, { id: input.id, expectedVersion: source.row.version, idempotencyKey: crypto.randomUUID(),
          reason: "Inspect the current financial recognition authority", currentPeriod }, tx);
        canRequest = !currentPeriod || await periods.postingOpen(await source.finance.clock());
      } catch (error) {
        if (!(error instanceof SupplierInvoiceAccessError || error instanceof SupplierInvoiceConflictError)) throw error;
      }
    }
    const result = { id: input.id, version: source.row.version, recognized: Boolean(source.existing), pending: Boolean(pending), canRequest, currentPeriod,
      amount: source.revision.amount.toFixed(2), currency: source.revision.currency, sourceCosts: source.costs.length,
      recognizedAt: source.existing?.createdAt.toISOString() ?? null,
      ...supplierInvoiceRequestHistory(history) };
    await source.recheck(await source.finance.clock());
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...supplierInvoiceOrganizationResource(ctx.organizationId), data: result },
      catalogFieldPolicy<typeof result>("supplier_invoice"), await source.finance.clock()) as typeof result;
  });
}
