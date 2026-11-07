import { createHash } from "node:crypto";
import { signatureRequestInputSchema, signatureMaximumPdfBytes, signatureRequestIdSchema, signatureExpirationSchema, signatureEmailSettingsSchema, SignatureProviderError, SignatureProviderConfigurationError, type SignatureRequestInput, type SignatureRequestObservation } from "./signature-contract";
export * from "./signature-contract";

/** Capture owned immutable PDF bytes before the first asynchronous provider boundary. */
export function captureSignatureRequest(raw: unknown): SignatureRequestInput {
  const input = signatureRequestInputSchema.parse(raw), bytes = new Uint8Array(input.file.bytes);
  if (bytes.length < 8 || bytes.length > signatureMaximumPdfBytes || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-" ||
    createHash("sha256").update(bytes).digest("hex") !== input.file.sha256) throw new SignatureProviderConfigurationError();
  return { ...input, file: { ...input.file, bytes } };
}

/** Verify the provider's real original bytes and native signing contract before any send. */
export function assertSignatureRequestObservation(raw: SignatureRequestInput, actual: SignatureRequestObservation,
  scope: { requestId: string; teamId: number; distributionMethod: "NONE" | "EMAIL"; originalPdf: Uint8Array }) {
  const expected = captureSignatureRequest(raw), fail = (): never => { throw new SignatureProviderError("NONE"); },
    recipientKey = (recipient: { email: string; name: string; role: string; signingOrder: number | null }) => JSON.stringify([recipient.email, recipient.name, recipient.role, recipient.signingOrder]),
    fieldKey = (field: { type: string; page: number; positionX: number; positionY: number; width: number; height: number }) => JSON.stringify([field.type, field.page, field.positionX, field.positionY, field.width, field.height]);
  if (!signatureRequestIdSchema.safeParse(scope.requestId).success || !Number.isSafeInteger(scope.teamId) || scope.teamId <= 0 ||
    actual.requestId !== scope.requestId || actual.teamId !== scope.teamId || actual.reference !== expected.reference || actual.title !== expected.title || actual.locale !== expected.locale ||
    actual.distributionMethod !== scope.distributionMethod || actual.signingOrder !== expected.signingOrder || actual.allowDictateNextSigner ||
    actual.methods.typed !== expected.methods.typed || actual.methods.draw !== expected.methods.draw || actual.methods.upload !== expected.methods.upload ||
    actual.items.length !== 1 || actual.items[0].requestId !== actual.requestId || actual.items[0].title !== expected.file.name ||
    scope.originalPdf.length !== expected.file.bytes.length || createHash("sha256").update(scope.originalPdf).digest("hex") !== expected.file.sha256 ||
    actual.recipients.length !== expected.recipients.length || new Set(expected.recipients.map(recipient => recipient.email.toLowerCase())).size !== expected.recipients.length ||
    new Set(actual.recipients.map(recipient => recipient.id)).size !== actual.recipients.length || actual.fields.length !== expected.recipients.reduce((count, recipient) => count + recipient.fields.length, 0)) fail();
  if (scope.distributionMethod === "NONE" && (actual.status !== "DRAFT" || actual.recipients.some(recipient => recipient.sendStatus !== "NOT_SENT" || recipient.signingStatus !== "NOT_SIGNED" || recipient.readStatus !== "NOT_OPENED" || recipient.signedAt !== null))) fail();
  if (scope.distributionMethod === "EMAIL" && actual.status === "DRAFT") fail();
  if (expected.delivery) {
    const expiration = signatureExpirationSchema.safeParse(actual.expiration), settings = signatureEmailSettingsSchema.safeParse(actual.emailSettings);
    if (!expiration.success || !settings.success || JSON.stringify(expiration.data) !== JSON.stringify(expected.delivery.expiration) || JSON.stringify(settings.data) !== JSON.stringify(expected.delivery.emailSettings)) fail();
  }
  const matched = new Set<number>();
  for (const recipient of expected.recipients) {
    const candidates = actual.recipients.filter(value => recipientKey(value) === recipientKey(recipient)), native = candidates[0];
    if (candidates.length !== 1 || !native || native.requestId !== actual.requestId || matched.has(native.id)) fail(); matched.add(native.id);
    const fields = actual.fields.filter(field => field.recipientId === native.id);
    if (fields.some(field => field.itemId !== actual.items[0].id) || JSON.stringify(fields.map(fieldKey).sort()) !== JSON.stringify(recipient.fields.map(fieldKey).sort())) fail();
  }
  if (actual.fields.some(field => !matched.has(field.recipientId))) fail();
}
