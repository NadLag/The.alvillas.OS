import { z } from "zod";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { paymentRefundIntent } from "@/platform/providers/payment-refund";
import { externalRefundRequestInput } from "./external-payment-refund-command";
import { GuestDepositSourceError } from "./guest-deposit";
import { Money } from "@/platform/money/money";
import { providerRefundEvidenceSchema } from "@/platform/providers/payment-refund";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";

const identity = z.uuid().transform(value => value.toLowerCase());
export const externalPaymentRefundInput = externalRefundRequestInput;
export class ExternalPaymentRefundError extends GuestDepositSourceError { constructor() { super(); this.message = "external_payment_refund_unavailable"; } }

export function retainExternalPaymentRefund(raw: unknown, organizationId: string, actorId: string) {
  const parsed = externalPaymentRefundInput.safeParse(raw), organization = identity.safeParse(organizationId), actor = identity.safeParse(actorId);
  if (!parsed.success || !organization.success || !actor.success) throw new ExternalPaymentRefundError();
  const refund = parsed.data.refund;
  // Reuse the same exact provider Money validation without treating a database UUID as a provider capture.
  const validated = paymentRefundIntent({ captureId: parsed.data.captureId, requestId: refund.idempotencyKey, amount: refund.amount, currency: refund.currency });
  const input = { captureId: parsed.data.captureId, refund: { ...refund, amount: validated.amount } }, canonicalRequest = JSON.stringify({ organizationId: organization.data, actorId: actor.data, input });
  return { organizationId: organization.data, requestedBy: actor.data, idempotencyKey: refund.idempotencyKey, input, canonicalRequest,
    fingerprint: commandFingerprint({ organizationId: organization.data, actorId: actor.data, input }) };
}

/** Verify immutable request facts in their original identity; this grants no caller authority. */
export function assertExternalPaymentRefund(request: { input: unknown; organizationId: string; requestedBy: string; requestFingerprint: string; canonicalRequest: string }) {
  const saved = retainExternalPaymentRefund(request.input, request.organizationId, request.requestedBy);
  if (saved.fingerprint !== request.requestFingerprint || saved.canonicalRequest !== request.canonicalRequest) throw new ExternalPaymentRefundError();
  return saved;
}

export type VerifiedRefundRequest = Parameters<typeof assertExternalPaymentRefund>[0] & { captureId: string; depositId: string; idempotencyKey: string; amount: { toString(): string }; currency: string;
  capture: { paymentId: string }; identity: { id: string; refundId: string; observations: Array<{ id: string; state: string; refundedAt: Date | null; evidence: unknown;
    settlement: { id: string; settlement: unknown } | null }> } | null };

/** Provider proof and original request consistency are independent from the identity allowed to record them. */
export function verifiedExternalPaymentRefund(request: VerifiedRefundRequest) {
  const saved = assertExternalPaymentRefund(request), observation = request.identity?.observations[0], evidence = providerRefundEvidenceSchema.safeParse(observation?.evidence),
    settlement = providerRefundSettlementSchema.safeParse(observation?.settlement?.settlement), amount = Money.of(saved.input.refund.amount, saved.input.refund.currency);
  if (request.captureId !== saved.input.captureId || request.depositId !== saved.input.refund.depositId || request.idempotencyKey !== saved.idempotencyKey ||
    !amount.equals(Money.of(request.amount.toString(), request.currency)) || !request.identity || !observation || observation.state !== "COMPLETED" || !observation.refundedAt ||
    !evidence.success || evidence.data.state !== "COMPLETED" || !evidence.data.refundedAt || observation.refundedAt.getTime() !== new Date(evidence.data.refundedAt).getTime() ||
    evidence.data.refundId !== request.identity.refundId || evidence.data.captureId !== request.capture.paymentId || evidence.data.requestId !== saved.idempotencyKey ||
    !amount.equals(Money.of(evidence.data.amount.amount, evidence.data.amount.currency)) || !settlement.success ||
    !amount.equals(Money.of(settlement.data.gross.amount, settlement.data.gross.currency)) ||
    !amount.subtract(Money.of(settlement.data.fee.amount, settlement.data.fee.currency)).equals(Money.of(settlement.data.net.amount, settlement.data.net.currency))) throw new ExternalPaymentRefundError();
  return { saved, observation, evidence: evidence.data, settlement: settlement.data };
}
