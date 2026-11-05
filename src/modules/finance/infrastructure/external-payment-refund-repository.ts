import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";
import type { z } from "zod";
import type { providerRefundEvidenceSchema } from "@/platform/providers/payment-refund";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import type { retainExternalPaymentRefund } from "../domain/external-payment-refund-intent";
import { GuestDepositRepository } from "./guest-deposit-repository";

const include = { capture: { include: { intent: true } }, attempt: true, identity: { include: { observations: { include: { settlement: true }, orderBy: [{ providerUpdatedAt: "desc" }, { id: "desc" }], take: 1 } } } } satisfies Prisma.ExternalPaymentRefundIntentInclude;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
export class ExternalPaymentRefundRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  find(id: string) { return this.tx.externalPaymentRefundIntent.findUnique({ where: { organizationId_id: { organizationId: this.organizationId, id } }, include }); }
  byKey(idempotencyKey: string) { return this.tx.externalPaymentRefundIntent.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include }); }
  capture(id: string) { return this.tx.externalPaymentCapture.findUnique({ where: { organizationId_id: { organizationId: this.organizationId, id } }, include: { intent: true } }); }
  reserved(depositId: string) { return new GuestDepositRepository(this.tx, this.organizationId).reservedExternalRefunds(depositId); }
  cancellation(intentId: string) { return new GuestDepositRepository(this.tx, this.organizationId).externalRefundCancellation(intentId); }
  supervisionReview(reviewId: string, actorId: string) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, actorId, resourceType: "financial_transaction", action: "finance.external_payment.refund_supervision_reviewed",
      after: { path: ["reviewId"], equals: reviewId } } });
  }
  supervisedAdmissionReview(reviewId: string, actorId: string) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, actorId, resourceType: "financial_transaction", action: "finance.external_payment.refund_supervised_admission_reviewed",
      after: { path: ["reviewId"], equals: reviewId } } });
  }
  supervisedAdmissionByKey(key: string, actorId: string) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, actorId, resourceType: "financial_transaction", action: "finance.external_payment.refund_supervised_admitted",
      after: { path: ["commandKey"], equals: key } } });
  }
  async committedAudit(id: string) {
    const rows = await this.tx.$queryRaw<Array<{ committed: boolean }>>`SELECT xmin::text<>pg_current_xact_id()::xid::text AS committed FROM audit_log WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid`;
    return rows.length === 1 && rows[0].committed;
  }
  create(saved: ReturnType<typeof retainExternalPaymentRefund>, authorizationCap: AuthorizationCap) {
    return this.tx.externalPaymentRefundIntent.create({ data: { organizationId: this.organizationId, captureId: saved.input.captureId,
      depositId: saved.input.refund.depositId, requestedBy: saved.requestedBy, amount: saved.input.refund.amount, currency: saved.input.refund.currency,
      idempotencyKey: saved.idempotencyKey, requestFingerprint: saved.fingerprint, canonicalRequest: saved.canonicalRequest, input: json(saved.input), authorizationCap }, include });
  }
  attempt(intentId: string) { return this.tx.externalPaymentRefundAttempt.create({ data: { organizationId: this.organizationId, intentId } }); }
  failure(intentId: string, outboxEventId: string) { return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, resourceType: "financial_transaction", resourceId: intentId,
    action: "finance.external_payment.refund_unconfirmed", after: { path: ["outboxEventId"], equals: outboxEventId } }, select: { id: true } }); }
  async observe(request: NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>, evidence: z.infer<typeof providerRefundEvidenceSchema>) {
    const identity = request.identity ?? await this.tx.externalPaymentRefundIdentity.create({ data: { organizationId: this.organizationId, intentId: request.id, provider: "paypal", refundId: evidence.refundId } });
    if (identity.refundId !== evidence.refundId) throw Error("external_payment_refund_unavailable");
    const where = { organizationId_identityId_providerUpdatedAt_state: { organizationId: this.organizationId, identityId: identity.id, providerUpdatedAt: new Date(evidence.updatedAt), state: evidence.state } };
    const existing = await this.tx.externalPaymentRefundEvidence.findUnique({ where });
    if (existing) return { identity, observation: existing, idempotent: true };
    const observation = await this.tx.externalPaymentRefundEvidence.create({ data: { organizationId: this.organizationId, identityId: identity.id, state: evidence.state,
      providerCreatedAt: new Date(evidence.createdAt), providerUpdatedAt: new Date(evidence.updatedAt), refundedAt: evidence.refundedAt ? new Date(evidence.refundedAt) : null, evidence: json(evidence) } });
    return { identity, observation, idempotent: false };
  }
  async retainSettlement(evidenceId: string, settlement: z.infer<typeof providerRefundSettlementSchema>) {
    const existing = await this.tx.externalPaymentRefundSettlement.findUnique({ where: { organizationId_evidenceId: { organizationId: this.organizationId, evidenceId } } });
    if (existing) {
      const previous = providerRefundSettlementSchema.safeParse(existing.settlement);
      if (!previous.success || JSON.stringify(previous.data) !== JSON.stringify(settlement)) throw new ExternalPaymentRefundError();
      return { row: existing, idempotent: true };
    }
    return { row: await this.tx.externalPaymentRefundSettlement.create({ data: { organizationId: this.organizationId, evidenceId, settlement: json(settlement) } }), idempotent: false };
  }
  flushGuards() { return new GuestDepositRepository(this.tx, this.organizationId).flushGuards(); }
}
