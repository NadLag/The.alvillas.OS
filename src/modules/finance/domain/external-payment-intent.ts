import { z } from "zod";
import { paymentCaptureIntent } from "@/platform/providers/payment-capture";
import { externalPaymentIntentInput } from "./external-payment-command";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { PaymentMethodSourceError } from "./payment-method";

export { externalPaymentSourceSchema } from "@/platform/ledger/external-payment-source";
const identity = z.uuid().transform(value => value.toLowerCase());
export { externalPaymentIntentInput } from "./external-payment-command";
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
