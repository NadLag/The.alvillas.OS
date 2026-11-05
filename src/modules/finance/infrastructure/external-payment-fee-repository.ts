import type { TenantTransaction } from "@/platform/db/tenant";

/** Source metadata only; allocation, approval and every monetary movement remain native expense responsibilities. */
export class ExternalPaymentFeeRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  byCapture(captureId: string) { return this.tx.externalPaymentFee.findUnique({ where: { organizationId_captureId: { organizationId: this.organizationId, captureId } }, include: { expense: true } }); }
  create(input: { captureId: string; expenseId: string; createdBy: string; propertyTimezone: string }) {
    return this.tx.externalPaymentFee.create({ data: { organizationId: this.organizationId, ...input } });
  }
}
