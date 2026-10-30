import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

const include = { lines: { orderBy: { invoiceLineId: "asc" as const }, include: { transaction: { select: { id: true, occurredAt: true, reversesTransactionId: true } },
  periodAdjustment: { select: { id: true, periodId: true, periodEventId: true } } } } } satisfies Prisma.SupplierInvoiceRecognitionInclude;

export class SupplierInvoiceRecognitionRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  byInvoice(invoiceId: string) { return this.tx.supplierInvoiceRecognition.findFirst({ where: { organizationId: this.organizationId, invoiceId }, include }); }
  byKey(idempotencyKey: string) { return this.tx.supplierInvoiceRecognition.findFirst({ where: { organizationId: this.organizationId, idempotencyKey }, include }); }
  create(input: { invoiceId: string; submissionId: string; invoiceVersion: number; currentPeriod: boolean; idempotencyKey: string; requestFingerprint: string; reason: string; createdBy: string }) {
    return this.tx.supplierInvoiceRecognition.create({ data: { organizationId: this.organizationId, ...input } });
  }
  async lines(input: ReadonlyArray<{ recognitionId: string; invoiceLineId: string; transactionId: string; sourceOccurredAt: Date }>) {
    return this.tx.supplierInvoiceRecognitionLine.createManyAndReturn({ data: input.map(line => ({ organizationId: this.organizationId, ...line })) });
  }
  async flushGuards() {
    // Complete the atomic history and journal guards before the final DB-clock authority fence.
    await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
  }
}
