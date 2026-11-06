import { createHash } from "node:crypto";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { documentEncryptionContext, documentObjectIdentitySchema, type DocumentObjectIdentity } from "../domain/document-object";
import { validateGeneratedPdf } from "../domain/document-pdf";
import { DocumentConfigurationError, DocumentConflictError, DocumentStorageError } from "../domain/document-command";

function validate(identity: DocumentObjectIdentity, bytes: Uint8Array) {
  documentObjectIdentitySchema.parse(identity);
  if (identity.contentType !== "application/pdf" || identity.fileSize !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== identity.sha256) throw new DocumentConflictError();
  validateGeneratedPdf(bytes, identity.fileSize); return bytes;
}
const context = (identity: DocumentObjectIdentity) => documentEncryptionContext(documentObjectIdentitySchema.parse(identity)) + ":generated-pdf-intent-v1";
export function sealGeneratedDocumentPayload(identity: DocumentObjectIdentity, bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  return encryptBytes(validate(identity, bytes), context(identity), env);
}
export function openGeneratedDocumentPayload(identity: DocumentObjectIdentity, cipher: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  try { return validate(identity, decryptBytes(cipher, context(identity), env)); } catch { throw new DocumentStorageError(); }
}
