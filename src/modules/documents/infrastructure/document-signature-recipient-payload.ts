import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { nativeSignatureRecipientIdentitySchema, nativeSignatureRecipientPayloadSchema } from "../domain/document-signature-command";
import type { z } from "zod";

const maximum = 8192, context = (raw: z.infer<typeof nativeSignatureRecipientIdentitySchema>) => "alvillas:documents:signature-recipient-v1:" + commandFingerprint(nativeSignatureRecipientIdentitySchema.parse(raw));
export function sealNativeSignatureRecipient(raw: z.infer<typeof nativeSignatureRecipientPayloadSchema>, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError(); const value = nativeSignatureRecipientPayloadSchema.parse(raw), bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > maximum) throw new DocumentConflictError(); return encryptBytes(bytes, context(value.identity), env);
}
export function openNativeSignatureRecipient(identity: z.infer<typeof nativeSignatureRecipientIdentitySchema>, cipher: Uint8Array, env: NodeJS.ProcessEnv = process.env) {
  if (!env.ENCRYPTION_KEYS?.trim()) throw new DocumentConfigurationError();
  try { const bytes = decryptBytes(cipher, context(identity), env); if (bytes.length > maximum) throw new DocumentConflictError();
    const value = nativeSignatureRecipientPayloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (commandFingerprint(value.identity) !== commandFingerprint(identity)) throw new DocumentConflictError(); return value;
  } catch { throw new DocumentConflictError(); }
}
