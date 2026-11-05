import { z } from "zod";
import { paymentCaptureIntent } from "@/platform/providers/payment-capture";
import { guestDepositReceiptInput } from "./guest-deposit-command";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { PaymentMethodSourceError } from "./payment-method";

const identity = z.uuid().transform(value => value.toLowerCase());
export const externalPaymentSourceSchema = z.object({ schemaVersion: z.literal(1), organizationId: identity, userAccountId: identity, personId: identity,
  reservationId: identity, propertyId: identity, guestId: identity, bookingSource: z.string().min(1), financialSnapshotId: identity, financialSnapshotVersion: z.number().int().positive(),
  city: z.string(), region: z.string().nullable(), accountId: identity, amount: z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict(), receivedAt: z.iso.datetime() }).strict();
export const externalPaymentIntentInput = z.object({
  provider: z.literal("paypal"), orderId: z.string().regex(/^[A-Za-z0-9_-]{1,127}$/u),
  receipt: guestDepositReceiptInput.extend({ paymentMethodFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }),
}).strict();
export class ExternalPaymentIntentError extends PaymentMethodSourceError { constructor() { super(); this.message = "external_payment_intent_unavailable"; } }

/** Retains the reviewed native command; capture success does not grant financial admission. */
export function retainExternalPaymentIntent(raw: unknown, organizationId: string, actorId: string) {
  const source = externalPaymentIntentInput.safeParse(raw), organization = identity.safeParse(organizationId), actor = identity.safeParse(actorId);
  if (!source.success || !organization.success || !actor.success) throw new ExternalPaymentIntentError();
  const { provider, orderId, receipt } = source.data;
  if (receipt.externalReference !== orderId) throw new ExternalPaymentIntentError();
  let capture: ReturnType<typeof paymentCaptureIntent>;
  try { capture = paymentCaptureIntent({ source: orderId, amount: receipt.amount, currency: receipt.currency }); }
  catch { throw new ExternalPaymentIntentError(); }
  const input = { provider, orderId, receipt: { ...receipt, amount: capture.amount } };
  return { organizationId: organization.data, requestedBy: actor.data, idempotencyKey: receipt.idempotencyKey, input,
    fingerprint: commandFingerprint({ organizationId: organization.data, actorId: actor.data, input }),
    capture, sourceIdentity: commandFingerprint({ provider, orderId }) };
}

export function assertExternalPaymentIntent(saved: ReturnType<typeof retainExternalPaymentIntent>, raw: unknown, organizationId: string, actorId: string) {
  const current = retainExternalPaymentIntent(raw, organizationId, actorId);
  if (saved.organizationId !== current.organizationId || saved.requestedBy !== current.requestedBy || saved.fingerprint !== current.fingerprint || saved.idempotencyKey !== current.idempotencyKey || saved.sourceIdentity !== current.sourceIdentity) throw new ExternalPaymentIntentError();
  return current;
}
