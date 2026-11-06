import { createHash } from "node:crypto";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { documentGenerationIdentitySchema, documentGenerationMaximumInputBytes, type DocumentGenerationIdentity } from "../domain/document-generation";
import { documentPdfInputSchema } from "../domain/document-pdf";
import { DocumentConfigurationError, DocumentConflictError, DocumentStorageError } from "../domain/document-command";

export function encodeDocumentGenerationInput(raw: unknown): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(JSON.stringify(documentPdfInputSchema.parse(raw)));
  if (bytes.length > documentGenerationMaximumInputBytes) throw new DocumentConflictError();
  return bytes;
}
function validate(identity: DocumentGenerationIdentity, bytes: Uint8Array) {
  const expected = documentGenerationIdentitySchema.parse(identity);
  if (bytes.length !== expected.byteSize || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new DocumentConflictError();
  const input = documentPdfInputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (input.provenance.templateVersionId !== expected.templateVersionId || input.provenance.templateSha256 !== expected.templateSha256 || input.provenance.sourceFingerprint !== expected.sourceFingerprint) throw new DocumentConflictError();
  return input;
}
const context = (identity: DocumentGenerationIdentity) => {
  const value = documentGenerationIdentitySchema.parse(identity);
  return ["alvillas", "documents", "generation-v1", value.organizationId, value.documentId, value.instanceId, value.templateVersionId, value.templateSha256, value.sourceFingerprint, value.sha256, value.byteSize].join(":");
};
export function sealDocumentGenerationInput(identity: DocumentGenerationIdentity, bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  const captured = Buffer.from(bytes); validate(identity, captured); return encryptBytes(captured, context(identity), env);
}
export function openDocumentGenerationInput(identity: DocumentGenerationIdentity, cipher: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  try { const bytes = decryptBytes(cipher, context(identity), env); return validate(identity, bytes); }
  catch { throw new DocumentStorageError(); }
}
