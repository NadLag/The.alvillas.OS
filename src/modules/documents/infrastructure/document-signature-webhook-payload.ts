import { createHash } from "node:crypto";
import type { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { signatureWebhookIdentitySchema } from "../domain/document-signature-webhook";

type Identity = z.infer<typeof signatureWebhookIdentitySchema>;
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex"), context = (identity: Identity) => "alvillas:documents:signature-webhook-v1:" + commandFingerprint(identity);
function checked(raw: Identity, bytes: Uint8Array) { const identity = signatureWebhookIdentitySchema.parse(raw); if (bytes.length !== identity.payloadByteSize || digest(bytes) !== identity.payloadSha256) throw new DocumentConflictError(); return identity; }
export function sealSignatureWebhook(raw: Identity, bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError(); const original = new Uint8Array(bytes), identity = checked(raw, original); return encryptBytes(original, context(identity), env);
}
export function openSignatureWebhook(raw: Identity, cipher: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  try { const identity = signatureWebhookIdentitySchema.parse(raw); if (cipher.length <= identity.payloadByteSize || cipher.length > identity.payloadByteSize + 256) throw new DocumentConflictError(); const bytes = decryptBytes(cipher, context(identity), env); checked(identity, bytes); return new Uint8Array(bytes); } catch { throw new DocumentConflictError(); }
}
