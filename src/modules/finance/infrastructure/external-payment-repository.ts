import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";
import type { retainExternalPaymentIntent } from "../domain/external-payment-intent";
import { FinancialTransferRepository } from "./financial-transfer-repository";
import { ExternalPaymentIntentError } from "../domain/external-payment-intent";
import { GuestPaymentProvenanceRepository } from "./guest-payment-provenance-repository";
import { GuestDepositRepository } from "./guest-deposit-repository";
import type { payPalCaptureSettlement } from "@/platform/providers/payment-capture";

type Intent = ReturnType<typeof retainExternalPaymentIntent>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
export class ExternalPaymentRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  lock(key: string) { return new FinancialTransferRepository(this.tx, this.organizationId).lock("external-payment:" + key); }
  find(id: string) { return this.tx.externalPaymentIntent.findUnique({ where: { organizationId_id: { organizationId: this.organizationId, id } }, include: { capture: true, attempt: true } }); }
  byKey(idempotencyKey: string) { return this.tx.externalPaymentIntent.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey } }, include: { capture: true, attempt: true } }); }
  async sourceSnapshot(saved: Intent, personId: string | undefined) {
    const repository = new GuestPaymentProvenanceRepository(this.tx, this.organizationId);
    const [actor, booking, snapshot, source] = await Promise.all([repository.actor(saved.requestedBy), repository.booking(saved.input.receipt.reservationId),
      repository.financialSnapshot(saved.input.receipt.reservationId), new GuestDepositRepository(this.tx, this.organizationId).source(saved.input.receipt.reservationId)]);
    if (!actor || !booking || !snapshot || !source || !personId || actor.personId !== personId || !booking.guestId) throw new ExternalPaymentIntentError();
    return { schemaVersion: 1 as const, organizationId: this.organizationId, userAccountId: actor.id, personId, reservationId: booking.id, propertyId: booking.propertyId,
      guestId: booking.guestId, bookingSource: booking.source, financialSnapshotId: snapshot.id, financialSnapshotVersion: snapshot.version,
      city: source.property.cityId ?? source.property.city, region: source.property.regionId ?? source.property.region, accountId: saved.input.receipt.accountId,
      amount: { amount: saved.capture.amount, currency: saved.capture.currency }, receivedAt: saved.input.receipt.receivedAt };
  }
  create(saved: Intent, authorizationCap: AuthorizationCap, policy: { id: string; version: number }, sourceSnapshot: Awaited<ReturnType<ExternalPaymentRepository["sourceSnapshot"]>>) {
    return this.tx.externalPaymentIntent.create({ data: { organizationId: this.organizationId, requestedBy: saved.requestedBy,
      reservationId: saved.input.receipt.reservationId, accountId: saved.input.receipt.accountId, provider: saved.input.provider, orderId: saved.input.orderId,
      sourceIdentity: saved.sourceIdentity, idempotencyKey: saved.idempotencyKey, requestFingerprint: saved.fingerprint,
      canonicalRequest: JSON.stringify({ organizationId: saved.organizationId, actorId: saved.requestedBy, input: saved.input }),
      policyId: policy.id, policyVersion: policy.version, sourceSnapshot, amount: saved.capture.amount, currency: saved.capture.currency, input: json(saved.input), authorizationCap } }).catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ExternalPaymentIntentError();
        throw error;
      });
  }
  attempt(intentId: string) { return this.tx.externalPaymentAttempt.create({ data: { organizationId: this.organizationId, intentId } }); }
  failure(intentId: string, outboxEventId: string) { return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, resourceType: "financial_transaction", resourceId: intentId,
    action: "finance.external_payment.capture_unconfirmed", after: { path: ["outboxEventId"], equals: outboxEventId } }, select: { id: true } }); }
  capture(intentId: string, evidence: { schemaVersion: 1; provider: "paypal"; orderId: string; paymentId: string; amount: { amount: string; currency: string } }, capturedAt: string, settlement: ReturnType<typeof payPalCaptureSettlement>) {
    return this.tx.externalPaymentCapture.create({ data: { organizationId: this.organizationId, intentId, provider: evidence.provider, paymentId: evidence.paymentId,
      amount: evidence.amount.amount, currency: evidence.amount.currency, evidence: json(evidence), capturedAt: new Date(capturedAt), settlement: settlement ? json(settlement) : Prisma.DbNull } });
  }
  async flushGuards() { await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); }
}
