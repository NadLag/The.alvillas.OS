import { createHash } from "node:crypto";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import type { AppLocale } from "@/i18n/routing";
import { documentEncryptionContext, documentObjectIdentitySchema, type DocumentObjectIdentity } from "../domain/document-object";
import { decodeDocumentTemplate } from "../domain/document-template";
import { documentTemplateMediaType } from "../domain/document-template-format";
import { DocumentConfigurationError, DocumentConflictError, DocumentStorageError } from "../domain/document-command";

export type TemplatePayloadIdentity = DocumentObjectIdentity & { templateKey: string; locale: AppLocale };
export function validateDocumentTemplateBytes(expected: Pick<TemplatePayloadIdentity,"contentType"|"fileSize"|"sha256"|"templateKey"|"locale">, bytes: Uint8Array) {
  if (expected.contentType !== documentTemplateMediaType || bytes.length !== expected.fileSize || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) throw new DocumentConflictError();
  const definition = decodeDocumentTemplate(bytes);
  if (definition.templateKey !== expected.templateKey || definition.locale !== expected.locale) throw new DocumentConflictError();
  return definition;
}
const context = (identity: TemplatePayloadIdentity) => {
  const original = { organizationId: identity.organizationId, documentId: identity.documentId, admissionId: identity.admissionId,
    contentType: identity.contentType, fileSize: identity.fileSize, sha256: identity.sha256 };
  documentObjectIdentitySchema.parse(original); return documentEncryptionContext(original) + ":template-intent-v1";
};
export function sealDocumentTemplatePayload(identity: TemplatePayloadIdentity, bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  validateDocumentTemplateBytes(identity, bytes); return encryptBytes(bytes, context(identity), env);
}
export function openDocumentTemplatePayload(identity: TemplatePayloadIdentity, cipher: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  try { const bytes = decryptBytes(cipher, context(identity), env); validateDocumentTemplateBytes(identity, bytes); return bytes; }
  catch { throw new DocumentStorageError(); }
}
