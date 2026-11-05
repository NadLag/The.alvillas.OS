import { z } from "zod";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { paymentRefundIntent } from "@/platform/providers/payment-refund";
import { externalRefundRequestInput } from "./external-payment-refund-command";
import { GuestDepositSourceError } from "./guest-deposit";

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
