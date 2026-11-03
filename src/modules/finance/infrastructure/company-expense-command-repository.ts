import { Prisma } from "@prisma/client";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

export class CompanyExpenseCommandRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}
  runner(): TenantTransactionRunner { return { $transaction: async work => work(this.tx) }; }
  async lock(key: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":company-expense-command:" + key},0))::text`);
  }
  byKey(idempotencyKey: string) {
    return this.tx.companyExpenseCommandReceipt.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } } });
  }
  revision(companyExpenseId: string, version: number) {
    return this.tx.companyExpenseRevision.findFirst({ where: { organizationId: this.organizationId, companyExpenseId, version } });
  }
  invoiceResult(id: string) {
    return this.tx.companyExpenseInvoiceLink.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  employeeResult(id: string) {
    return this.tx.companyExpenseCompensationLink.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  append(data: Omit<Prisma.CompanyExpenseCommandReceiptUncheckedCreateInput, "organizationId">) {
    return this.tx.companyExpenseCommandReceipt.create({ data: { organizationId: this.organizationId, ...data } });
  }
}
