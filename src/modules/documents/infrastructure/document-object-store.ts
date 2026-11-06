import { createHash } from "node:crypto";
import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import type { StorageProvider } from "@/platform/providers";
import { privateUploadTransportTimeoutMs } from "@/platform/storage/upload-protocol";
import { readBoundedResponseBytes } from "@/platform/http/read-exact-response";
import { documentObjectKey, documentEncryptionContext, documentObjectIdentitySchema, documentCipherIdentitySchema,
  type DocumentObjectIdentity, type DocumentCipherIdentity } from "../domain/document-object";
import { DocumentStorageError } from "../domain/document-command";

export type DocumentStorageProvider = StorageProvider & {
  createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }>;
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const lifetime = z.number().int().min(1).max(300);

/** Conditional object creation keeps the first ciphertext across lost acknowledgements. */
export class DocumentObjectStore {
  constructor(private readonly storage: DocumentStorageProvider, private readonly transport: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env) {}

  private requireKeys() { if (!this.env.ENCRYPTION_KEYS?.trim()) throw new DocumentStorageError(); }
  private keyVersion(bytes: Uint8Array) {
    const value = Buffer.from(bytes), boundary = value.indexOf(10);
    if (boundary < 0 || boundary > 255) throw new DocumentStorageError();
    const [format, version] = value.subarray(0, boundary).toString("utf8").split(":");
    if (format !== "alvillas-binary-v1" || !version || version.length > 180) throw new DocumentStorageError();
    return version;
  }
  private plain(identity: DocumentObjectIdentity, cipher: Uint8Array) {
    const bytes = decryptBytes(cipher, documentEncryptionContext(identity), this.env);
    if (bytes.length !== identity.fileSize || sha256(bytes) !== identity.sha256) throw new DocumentStorageError();
    return bytes;
  }
  private async retained(identity: DocumentObjectIdentity, ttl: number) {
    const signed = await this.storage.createSignedDownloadUrl({ key: documentObjectKey(identity), expiresInSeconds: lifetime.parse(ttl) });
    const response = await this.transport(signed.url, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
    if (!response.ok || !response.body) throw new DocumentStorageError();
    return Buffer.from(await readBoundedResponseBytes(response, identity.fileSize + 256));
  }
  async put(identity: DocumentObjectIdentity, bytes: Uint8Array, ttl: number) {
    try {
      this.requireKeys(); documentObjectIdentitySchema.parse(identity); lifetime.parse(ttl);
      if (bytes.length !== identity.fileSize || sha256(bytes) !== identity.sha256) throw new DocumentStorageError();
      let cipher = encryptBytes(bytes, documentEncryptionContext(identity), this.env);
      this.keyVersion(cipher);
      const signed = await this.storage.createSignedUploadUrl({ key: documentObjectKey(identity), contentType: "application/octet-stream" });
      const response = await this.transport(signed.url, { method: "PUT", headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
        body: new Uint8Array(cipher), redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
      if (response.status === 412) { cipher = await this.retained(identity, ttl); this.plain(identity, cipher); }
      else if (!response.ok) throw new DocumentStorageError();
      return { storageKey: documentObjectKey(identity), cipherSize: cipher.length, cipherSha256: sha256(cipher), keyVersion: this.keyVersion(cipher) };
    } catch { throw new DocumentStorageError(); }
  }
  async read(identity: DocumentObjectIdentity, expected: DocumentCipherIdentity, ttl: number) {
    try {
      this.requireKeys(); documentObjectIdentitySchema.parse(identity); documentCipherIdentitySchema.parse(expected);
      const cipher = await this.retained(identity, ttl);
      if (cipher.length !== expected.cipherSize || sha256(cipher) !== expected.cipherSha256 || this.keyVersion(cipher) !== expected.keyVersion) throw new DocumentStorageError();
      return this.plain(identity, cipher);
    } catch { throw new DocumentStorageError(); }
  }
}
