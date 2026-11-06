import { createHash } from "node:crypto";
import type { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { signatureProviderEvidenceIdentitySchema, signatureProviderEvidenceSourceSchema, signatureProviderEvidencePayloadSchema, signatureProviderEvidenceMaximumBytes } from "../domain/document-signature-provider-evidence";

type Identity = z.infer<typeof signatureProviderEvidenceIdentitySchema>;
type Payload = z.infer<typeof signatureProviderEvidencePayloadSchema>;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"), context = (identity: Identity) => "alvillas:documents:signature-provider-evidence-v1:" + commandFingerprint(signatureProviderEvidenceIdentitySchema.parse(identity));
export function sealSignatureProviderEvidence(raw: Payload, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError(); const payload = signatureProviderEvidencePayloadSchema.parse(raw), bytes = new TextEncoder().encode(JSON.stringify(payload));
  if (bytes.length > signatureProviderEvidenceMaximumBytes) throw new DocumentConflictError();
  const identity = signatureProviderEvidenceIdentitySchema.parse({ ...payload.identity, sha256: digest(bytes), byteSize: bytes.length });
  return { identity, cipher: encryptBytes(bytes, context(identity), env) };
}
export function openSignatureProviderEvidence(raw: Identity, cipher: Uint8Array, env: NodeJS.ProcessEnv = process.env): Payload {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  try {
    const identity = signatureProviderEvidenceIdentitySchema.parse(raw); if (cipher.length <= identity.byteSize || cipher.length > identity.byteSize + 256) throw new DocumentConflictError();
    const bytes = decryptBytes(cipher, context(identity), env); if (bytes.length !== identity.byteSize || digest(bytes) !== identity.sha256) throw new DocumentConflictError();
    const payload = signatureProviderEvidencePayloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), source = signatureProviderEvidenceSourceSchema.strip().parse(identity);
    if (commandFingerprint(payload.identity) !== commandFingerprint(source)) throw new DocumentConflictError(); return payload;
  } catch { throw new DocumentConflictError(); }
}
