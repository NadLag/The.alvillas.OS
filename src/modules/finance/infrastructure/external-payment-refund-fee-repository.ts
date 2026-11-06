import type { TenantTransaction } from "@/platform/db/tenant";

const expenses = { originalExpense: true, correctionExpense: true } as const;

/** Immutable provenance; native expenses remain the only cost and approval records. */
export class ExternalPaymentRefundFeeRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  byRefund(refundIntentId: string) {
    return this.tx.externalPaymentRefundFee.findUnique({ where: { organizationId_refundIntentId: { organizationId: this.organizationId, refundIntentId } }, include: expenses });
  }
  source(captureId: string) {
    return this.tx.externalPaymentFee.findUnique({ where: { organizationId_captureId: { organizationId: this.organizationId, captureId } }, include: { expense: true, capture: true } });
  }
  chain(captureId: string) {
    return this.tx.externalPaymentRefundFee.findMany({ where: { organizationId: this.organizationId, captureId }, include: expenses });
  }
  create(input: { refundIntentId: string; captureId: string; originalExpenseId: string; correctionExpenseId: string | null;
    originalExpenseVersion: number; currentCost: string; returnedFee: string; remainingCost: string; currency: string; propertyTimezone: string; createdBy: string }) {
    return this.tx.externalPaymentRefundFee.create({ data: { organizationId: this.organizationId, ...input }, include: expenses });
  }
  async isPosted(refundIntentId: string) {
    const [result] = await this.tx.$queryRaw<Array<{ posted: boolean }>>`SELECT app_external_refund_fee_is_posted(${refundIntentId}::uuid,${this.organizationId}::uuid) AS posted`;
    return result.posted;
  }
}
