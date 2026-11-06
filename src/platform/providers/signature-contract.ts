import { z } from "zod";

export const signatureMaximumPdfBytes = 10 * 1024 * 1024;
export const signatureMaximumEvidenceBytes = 1024 * 1024;
export const signatureTransportTimeoutMs = 30000;
export const signatureRequestIdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/u);
export const signatureRecipientRoleSchema = z.enum(["SIGNER", "APPROVER", "VIEWER", "CC", "ASSISTANT"]);
export const signatureProviderStatusSchema = z.enum(["DRAFT", "PENDING", "COMPLETED", "REJECTED", "CANCELLED"]);
export const signatureTeamIdSchema = z.number().int().positive().max(2147483647);
export const signatureMethodsSchema = z.object({ typed: z.boolean(), draw: z.boolean(), upload: z.boolean() }).strict();
export const signatureSigningOrderSchema = z.enum(["PARALLEL", "SEQUENTIAL"]);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const signatureExpirationSchema = z.union([z.object({ disabled: z.literal(true) }).strict(), z.object({ unit: z.enum(["day", "week", "month", "year"]), amount: positiveInteger }).strict()]);
const reminderPeriod = z.union([z.object({ disabled: z.literal(true) }).strict(), z.object({ unit: z.enum(["day", "week", "month"]), amount: positiveInteger }).strict()]);
export const signatureEmailSettingsSchema = z.object({ recipientSigningRequest: z.boolean(), recipientRemoved: z.boolean(), recipientSigned: z.boolean(), documentPending: z.boolean(), documentCompleted: z.boolean(), documentDeleted: z.boolean(), ownerDocumentCompleted: z.boolean(), ownerRecipientExpired: z.boolean(), ownerDocumentCreated: z.boolean() }).strict();
export const signatureDeliveryOptionsSchema = z.object({ expiration: signatureExpirationSchema, reminders: z.object({ sendAfter: reminderPeriod, repeatEvery: reminderPeriod }).strict(), emailSettings: signatureEmailSettingsSchema }).strict();
export const signatureFieldSchema = z.object({ type: z.enum(["SIGNATURE", "INITIALS", "NAME", "EMAIL", "DATE"]), page: z.number().int().min(1),
  positionX: z.number().min(0).max(100), positionY: z.number().min(0).max(100), width: z.number().gt(0).max(100), height: z.number().gt(0).max(100)
}).strict().refine(field => field.positionX + field.width <= 100 && field.positionY + field.height <= 100, "signature_field_outside_page");
export const signatureRequestInputSchema = z.object({ reference: z.string().min(1).max(255), title: z.string().min(1).max(255), locale: z.enum(["en", "fr", "ar"]),
  signingOrder: signatureSigningOrderSchema, methods: signatureMethodsSchema, delivery: signatureDeliveryOptionsSchema.optional(),
  file: z.object({ name: z.string().min(1).max(255).regex(/^[^/\\\r\n]+\.pdf$/iu), bytes: z.instanceof(Uint8Array), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  recipients: z.array(z.object({ name: z.string().min(1).max(255), email: z.email().max(254), role: signatureRecipientRoleSchema,
    signingOrder: z.number().int().min(0), fields: z.array(signatureFieldSchema).max(200) }).strict()).min(1).max(100)
}).strict();
export type SignatureRequestInput = z.infer<typeof signatureRequestInputSchema>;
export const signatureRequestMetadataSchema = signatureRequestInputSchema.extend({ file: signatureRequestInputSchema.shape.file.omit({ bytes: true }) });
export type SignatureRequestMetadata = z.infer<typeof signatureRequestMetadataSchema>;
export type SignatureRequestReceipt = { requestId: string; evidence: Uint8Array };
export const signatureDownloadInputSchema = z.object({ requestId: signatureRequestIdSchema, reference: z.string().min(1).max(255), itemId: signatureRequestIdSchema, version: z.enum(["original", "signed"]) }).strict();
export type SignatureRequestDownloadInput = z.infer<typeof signatureDownloadInputSchema>;
export type SignatureRequestDownload = { requestId: string; itemId: string; version: "original" | "signed"; bytes: Uint8Array; sha256: string; observation: SignatureRequestObservation };
const instant = z.iso.datetime({ offset: true }).nullable();
export const signatureObservationFactsSchema = z.object({ requestId: signatureRequestIdSchema, reference: z.string().min(1).max(255), title: z.string().min(1).max(255), status: signatureProviderStatusSchema, teamId: signatureTeamIdSchema,
  locale: z.enum(["en", "fr", "ar"]), signingOrder: signatureSigningOrderSchema, methods: signatureMethodsSchema, distributionMethod: z.enum(["NONE", "EMAIL"]), allowDictateNextSigner: z.boolean(), expiration: signatureExpirationSchema.nullable(), emailSettings: signatureEmailSettingsSchema.nullable(),
  recipients: z.array(z.object({ id: positiveInteger, requestId: signatureRequestIdSchema, name: z.string().max(255), email: z.email().max(254), role: signatureRecipientRoleSchema, signingOrder: z.number().int().nonnegative().nullable(),
    readStatus: z.enum(["NOT_OPENED", "OPENED"]), signingStatus: z.enum(["NOT_SIGNED", "SIGNED", "REJECTED"]), sendStatus: z.enum(["NOT_SENT", "SENT"]), signedAt: instant, expiresAt: instant }).strict()).max(100),
  items: z.array(z.object({ id: signatureRequestIdSchema, requestId: signatureRequestIdSchema, title: z.string().max(255) }).strict()).min(1).max(100),
  fields: z.array(z.object({ ...signatureFieldSchema.shape, type: z.string().min(1).max(40), id: positiveInteger, recipientId: positiveInteger, itemId: signatureRequestIdSchema }).strict()).max(10000)
}).strict().superRefine((value, ctx) => {
  if ([...value.recipients, ...value.items].some(item => item.requestId !== value.requestId) || new Set(value.recipients.map(recipient => recipient.id)).size !== value.recipients.length ||
    new Set(value.items.map(item => item.id)).size !== value.items.length || new Set(value.fields.map(field => field.id)).size !== value.fields.length ||
    value.fields.some(field => !value.recipients.some(recipient => recipient.id === field.recipientId) || !value.items.some(item => item.id === field.itemId) || field.positionX + field.width > 100 || field.positionY + field.height > 100)) ctx.addIssue({ code: "custom", message: "original_provider_envelope_parents_required" });
});
export const signatureRequestObservationSchema = signatureObservationFactsSchema.safeExtend({ evidence: z.instanceof(Uint8Array).refine(bytes => bytes.length > 0 && bytes.length <= signatureMaximumEvidenceBytes) });
export type SignatureRequestObservation = z.infer<typeof signatureRequestObservationSchema>;

export class SignatureProviderError extends Error {
  constructor(readonly effect: "NONE" | "UNCERTAIN", readonly status?: number) { super("signature_provider_unavailable"); this.name = "SignatureProviderError"; }
}
export class SignatureProviderConfigurationError extends Error {
  constructor() { super("signature_provider_configuration_unavailable"); this.name = "SignatureProviderConfigurationError"; }
}

