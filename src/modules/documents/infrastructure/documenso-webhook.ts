import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { signatureMaximumEvidenceBytes, signatureProviderStatusSchema, signatureRecipientRoleSchema, signatureRequestIdSchema } from "@/platform/providers/signature-request";

export const documensoDocumentEvents = ["DOCUMENT_CREATED", "DOCUMENT_SENT", "DOCUMENT_OPENED", "DOCUMENT_SIGNED", "DOCUMENT_COMPLETED", "DOCUMENT_REJECTED", "DOCUMENT_CANCELLED", "DOCUMENT_RECIPIENT_COMPLETED", "RECIPIENT_EXPIRED"] as const;
export class SignatureWebhookAccessError extends Error { constructor() { super("signature_webhook_unauthorized"); this.name = "SignatureWebhookAccessError"; } }
export class SignatureWebhookPayloadError extends Error { constructor() { super("signature_webhook_invalid"); this.name = "SignatureWebhookPayloadError"; } }

/** Documenso uses a shared header secret, not a body HMAC. Missing configuration always denies. */
export function authenticateDocumensoWebhook(received: string | null | undefined, expected: string | undefined): boolean {
  if (!received || !expected?.trim() || Buffer.byteLength(received) > 512 || Buffer.byteLength(expected) > 512) return false;
  return timingSafeEqual(createHash("sha256").update(received).digest(), createHash("sha256").update(expected).digest());
}
const nullableDate = z.iso.datetime({ offset: true }).nullable().optional();
const recipient = z.object({ id: z.number().int().positive(), envelopeId: signatureRequestIdSchema, role: signatureRecipientRoleSchema,
  readStatus: z.enum(["NOT_OPENED", "OPENED"]).optional(), signingStatus: z.enum(["NOT_SIGNED", "SIGNED", "REJECTED"]).optional(), sendStatus: z.enum(["NOT_SENT", "SENT"]).optional(),
  signedAt: nullableDate, expiresAt: nullableDate, expirationNotifiedAt: nullableDate });
const webhook = z.object({ event: z.enum(documensoDocumentEvents), createdAt: z.iso.datetime({ offset: true }), payload: z.object({ envelopeId: signatureRequestIdSchema,
  externalId: z.string().min(1).max(255).nullable().optional(), source: z.literal("DOCUMENT"), status: signatureProviderStatusSchema, completedAt: nullableDate,
  recipients: z.array(recipient).max(100) }) });

/** This private result carries evidence for encrypted persistence; it does not establish a signed archive version. */
export function decodeDocumensoWebhook(received: string | null | undefined, expected: string | undefined, raw: Uint8Array) {
  if (!authenticateDocumensoWebhook(received, expected)) throw new SignatureWebhookAccessError();
  if (!raw.length || raw.length > signatureMaximumEvidenceBytes) throw new SignatureWebhookPayloadError();
  try {
    const evidence = new Uint8Array(raw), parsed = webhook.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(evidence))), payload = parsed.payload;
    if (payload.recipients.some(value => value.envelopeId !== payload.envelopeId) || new Set(payload.recipients.map(value => value.id)).size !== payload.recipients.length) throw new SignatureWebhookPayloadError();
    const facts = { event: parsed.event, createdAt: new Date(parsed.createdAt).toISOString(), requestId: payload.envelopeId, reference: payload.externalId ?? null, status: payload.status,
      completedAt: payload.completedAt ? new Date(payload.completedAt).toISOString() : null,
      recipients: payload.recipients.map(({ envelopeId, ...value }) => ({ ...value, requestId: envelopeId })).sort((left, right) => left.id - right.id) };
    return { ...facts, eventId: commandFingerprint(facts), evidenceSha256: createHash("sha256").update(evidence).digest("hex"), evidence };
  } catch { throw new SignatureWebhookPayloadError(); }
}
