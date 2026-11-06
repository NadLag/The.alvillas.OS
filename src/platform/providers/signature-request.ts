import { createHash } from "node:crypto";
import { z } from "zod";

export const signatureMaximumPdfBytes = 10 * 1024 * 1024;
export const signatureMaximumEvidenceBytes = 1024 * 1024;
export const signatureTransportTimeoutMs = 30000;
export const signatureRequestIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/u);
export const signatureRecipientRoleSchema = z.enum(["SIGNER", "APPROVER", "VIEWER", "CC", "ASSISTANT"]);
export const signatureProviderStatusSchema = z.enum(["DRAFT", "PENDING", "COMPLETED", "REJECTED", "CANCELLED"]);
export const signatureFieldSchema = z.object({ type: z.enum(["SIGNATURE", "INITIALS", "NAME", "EMAIL", "DATE"]), page: z.number().int().min(1),
  positionX: z.number().min(0).max(100), positionY: z.number().min(0).max(100), width: z.number().gt(0).max(100), height: z.number().gt(0).max(100)
}).strict().refine(field => field.positionX + field.width <= 100 && field.positionY + field.height <= 100, "signature_field_outside_page");
export const signatureRequestInputSchema = z.object({ reference: z.string().min(1).max(255), title: z.string().min(1).max(255), locale: z.enum(["en", "fr", "ar"]),
  signingOrder: z.enum(["PARALLEL", "SEQUENTIAL"]), methods: z.object({ typed: z.boolean(), draw: z.boolean(), upload: z.boolean() }).strict(),
  file: z.object({ name: z.string().min(1).max(255).regex(/^[^/\\\r\n]+\.pdf$/iu), bytes: z.instanceof(Uint8Array), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  recipients: z.array(z.object({ name: z.string().min(1).max(255), email: z.email().max(254), role: signatureRecipientRoleSchema,
    signingOrder: z.number().int().min(0), fields: z.array(signatureFieldSchema).max(200) }).strict()).min(1).max(100)
}).strict();
export type SignatureRequestInput = z.infer<typeof signatureRequestInputSchema>;
export type SignatureRequestReceipt = { requestId: string; evidence: Uint8Array };
export type SignatureRequestObservation = { requestId: string; reference: string; title: string; status: z.infer<typeof signatureProviderStatusSchema>; teamId: number;
  locale: "en" | "fr" | "ar"; signingOrder: "PARALLEL" | "SEQUENTIAL"; methods: SignatureRequestInput["methods"]; distributionMethod: "NONE" | "EMAIL";
  recipients: { id: number; requestId: string; name: string; email: string; role: z.infer<typeof signatureRecipientRoleSchema>; readStatus: "NOT_OPENED" | "OPENED";
    signingStatus: "NOT_SIGNED" | "SIGNED" | "REJECTED"; sendStatus: "NOT_SENT" | "SENT"; signedAt: string | null; expiresAt: string | null }[];
  items: { id: string; requestId: string; title: string }[];
  fields: { id: number; recipientId: number; itemId: string; type: string; page: number; positionX: number; positionY: number; width: number; height: number }[]; evidence: Uint8Array };

export class SignatureProviderError extends Error {
  constructor(readonly effect: "NONE" | "UNCERTAIN", readonly status?: number) { super("signature_provider_unavailable"); this.name = "SignatureProviderError"; }
}
export class SignatureProviderConfigurationError extends Error {
  constructor() { super("signature_provider_configuration_unavailable"); this.name = "SignatureProviderConfigurationError"; }
}

/** Capture owned immutable PDF bytes before the first asynchronous provider boundary. */
export function captureSignatureRequest(raw: unknown): SignatureRequestInput {
  const input = signatureRequestInputSchema.parse(raw), bytes = new Uint8Array(input.file.bytes);
  if (bytes.length < 8 || bytes.length > signatureMaximumPdfBytes || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-" ||
    createHash("sha256").update(bytes).digest("hex") !== input.file.sha256) throw new SignatureProviderConfigurationError();
  return { ...input, file: { ...input.file, bytes } };
}
