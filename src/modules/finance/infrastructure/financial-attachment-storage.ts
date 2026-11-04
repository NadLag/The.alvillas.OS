import { createHash } from "node:crypto";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import type { StorageProvider } from "@/platform/providers";
import { privateUploadTransportTimeoutMs } from "@/platform/storage/upload-protocol";
import { readBoundedResponseBytes } from "@/platform/http/read-exact-response";
import { financialAttachmentEncryptionContext, FinancialAttachmentStorageError } from "../domain/financial-attachment";

export type FinancialAttachmentStorage = StorageProvider & { createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }> };
export type AttachmentObjectIdentity = { organizationId: string; transactionId: string; id: string; contentType: string; fileSize: number; sha256: string };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function financialAttachmentObjectKey(identity: AttachmentObjectIdentity): string {
  return `organizations/${identity.organizationId}/financial-transactions/${identity.transactionId}/attachments/${identity.id}.encrypted`;
}

/** Original encrypted objects are conditionally created, never overwritten, even after a lost acknowledgement. */
export class FinancialAttachmentObjectStore {
  constructor(private readonly storage: FinancialAttachmentStorage, private readonly transport: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env) {}
  private requireKeys() { if (!this.env.ENCRYPTION_KEYS?.trim()) throw new FinancialAttachmentStorageError(); }
  private async encrypted(identity: AttachmentObjectIdentity, ttl: number): Promise<Buffer> {
    const signed = await this.storage.createSignedDownloadUrl({ key: financialAttachmentObjectKey(identity), expiresInSeconds: ttl });
    const response = await this.transport(signed.url, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
    if (!response.ok || !response.body) throw new FinancialAttachmentStorageError();
    return Buffer.from(await readBoundedResponseBytes(response, identity.fileSize + 256));
  }
  private plain(identity: AttachmentObjectIdentity, encrypted: Uint8Array) {
    const bytes = decryptBytes(encrypted, financialAttachmentEncryptionContext(identity), this.env);
    if (bytes.length !== identity.fileSize || hash(bytes) !== identity.sha256) throw new FinancialAttachmentStorageError(); return bytes;
  }
  async put(identity: AttachmentObjectIdentity, bytes: Uint8Array, ttl: number) {
    this.requireKeys();
    try {
      if (bytes.length !== identity.fileSize || hash(bytes) !== identity.sha256) throw new FinancialAttachmentStorageError();
      let encrypted = encryptBytes(bytes, financialAttachmentEncryptionContext(identity), this.env);
      const keyVersion = encrypted.subarray(0, encrypted.indexOf(10)).toString("utf8").split(":")[1];
      if (!keyVersion || keyVersion.length > 180) throw new FinancialAttachmentStorageError();
      const signed = await this.storage.createSignedUploadUrl({ key: financialAttachmentObjectKey(identity), contentType: "application/octet-stream" });
      const response = await this.transport(signed.url, { method: "PUT", headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
        body: new Uint8Array(encrypted), redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
      if (response.status === 412) { encrypted = await this.encrypted(identity, ttl); this.plain(identity, encrypted); }
      else if (!response.ok) throw new FinancialAttachmentStorageError();
      const header = encrypted.subarray(0, encrypted.indexOf(10)).toString("utf8").split(":");
      return { storageKey: financialAttachmentObjectKey(identity), cipherSize: encrypted.length, cipherSha256: hash(encrypted), keyVersion: header[1] };
    } catch { throw new FinancialAttachmentStorageError(); }
  }
  async read(identity: AttachmentObjectIdentity, expected: { cipherSize: number; cipherSha256: string; keyVersion: string }, ttl: number) {
    this.requireKeys();
    try { const bytes = await this.encrypted(identity, ttl);
      if (bytes.length !== expected.cipherSize || hash(bytes) !== expected.cipherSha256 || bytes.subarray(0, bytes.indexOf(10)).toString("utf8").split(":")[1] !== expected.keyVersion) throw new FinancialAttachmentStorageError();
      return this.plain(identity, bytes);
    } catch { throw new FinancialAttachmentStorageError(); }
  }
}
