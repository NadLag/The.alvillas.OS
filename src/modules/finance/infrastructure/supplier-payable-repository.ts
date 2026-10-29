import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";

export class SupplierPayableRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  /** Every settlement and reversal for an invoice must hold this same tenant lock. */
  async lockInvoice(invoiceId: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":supplier-invoice:" + invoiceId},0))::text`);
  }

  async lockPaymentKey(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":supplier-payment:" + key},0))::text`);
  }

  paymentAudit(id: string) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, resourceType: "financial_transaction", resourceId: id,
      action: "finance.supplier_payment.posted" }, orderBy: { createdAt: "asc" } });
  }

  paymentAudits(ids: string[]) {
    return this.tx.auditLog.findMany({ where: { organizationId: this.organizationId, resourceType: "financial_transaction", resourceId: { in: ids },
      action: "finance.supplier_payment.posted" }, select: { resourceId: true, after: true } });
  }

  movementJournals(invoiceId: string) {
    return this.tx.financialTransaction.findMany({ where: { organizationId: this.organizationId,
      postings: { some: { dimensions: { path: ["supplier_invoice_id"], equals: invoiceId } } } }, orderBy: { id: "desc" },
      include: { postings: { include: { ledgerAccount: { select: { id: true, code: true, name: true, accountType: true, normalSide: true, archivedAt: true,
        teamWallet: { select: { id: true, personId: true, person: { select: { archivedAt: true } } } } } } } }, reversedByTransactions: true } });
  }

  async outstanding(input: { supplierId: string; invoiceId: string; currency: string }): Promise<Money> {
    const [row] = await this.tx.$queryRaw<Array<{ amount: Prisma.Decimal }>>(Prisma.sql`
      SELECT COALESCE(SUM(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END),0) AS amount
      FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
      JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
      WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency}
        AND a.code='SUPPLIER_PAYABLE' AND a.account_type='CLAIM_OWNERSHIP' AND a.normal_side='CREDIT'
        AND p.dimensions->>'supplier_id'=${input.supplierId} AND p.dimensions->>'supplier_invoice_id'=${input.invoiceId}
    `);
    return Money.of(row.amount.toString(), input.currency);
  }
}
