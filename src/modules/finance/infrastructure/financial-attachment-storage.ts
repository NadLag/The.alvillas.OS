import { createHash } from "node:crypto";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import type { StorageProvider } from "@/platform/providers";
import { privateUploadTransportTimeoutMs } from "@/platform/storage/upload-protocol";
import { readBoundedResponseBytes } from "@/platform/http/read-exact-response";
import { financialAttachmentEncryptionContext, FinancialAttachmentStorageError } from "../domain/financial-attachment";
import { financialAttachmentPartContract,type FinancialAttachmentParts } from "../domain/financial-attachment-parts";

export type FinancialAttachmentStorage = StorageProvider & { createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }> };
export type AttachmentObjectIdentity = { organizationId: string; transactionId: string; id: string; contentType: string; fileSize: number; sha256: string };
type ObjectContract={key:string;context:string;size:number;sha256:string};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function financialAttachmentObjectKey(identity: AttachmentObjectIdentity): string {
  return `organizations/${identity.organizationId}/financial-transactions/${identity.transactionId}/attachments/${identity.id}.encrypted`;
}

/** Original encrypted objects are conditionally created, never overwritten, even after a lost acknowledgement. */
export class FinancialAttachmentObjectStore {
  constructor(private readonly storage: FinancialAttachmentStorage, private readonly transport: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env) {}
  private requireKeys() { if (!this.env.ENCRYPTION_KEYS?.trim()) throw new FinancialAttachmentStorageError(); }
  private contract(identity:AttachmentObjectIdentity):ObjectContract{return{key:financialAttachmentObjectKey(identity),context:financialAttachmentEncryptionContext(identity),size:identity.fileSize,sha256:identity.sha256};}
  private async encrypted(contract: ObjectContract, ttl: number): Promise<Buffer> {
    const signed = await this.storage.createSignedDownloadUrl({ key: contract.key, expiresInSeconds: ttl });
    const response = await this.transport(signed.url, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
    if (!response.ok || !response.body) throw new FinancialAttachmentStorageError();
    return Buffer.from(await readBoundedResponseBytes(response, contract.size + 256));
  }
  private plain(contract: ObjectContract, encrypted: Uint8Array) {
    const bytes = decryptBytes(encrypted, contract.context, this.env);
    if (bytes.length !== contract.size || hash(bytes) !== contract.sha256) throw new FinancialAttachmentStorageError(); return bytes;
  }
  private async putContract(contract: ObjectContract, bytes: Uint8Array, ttl: number) {
    this.requireKeys();
    try {
      if (bytes.length !== contract.size || hash(bytes) !== contract.sha256) throw new FinancialAttachmentStorageError();
      let encrypted = encryptBytes(bytes, contract.context, this.env);
      const keyVersion = encrypted.subarray(0, encrypted.indexOf(10)).toString("utf8").split(":")[1];
      if (!keyVersion || keyVersion.length > 180) throw new FinancialAttachmentStorageError();
      const signed = await this.storage.createSignedUploadUrl({ key: contract.key, contentType: "application/octet-stream" });
      const response = await this.transport(signed.url, { method: "PUT", headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
        body: new Uint8Array(encrypted), redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
      if (response.status === 412) { encrypted = await this.encrypted(contract, ttl); this.plain(contract, encrypted); }
      else if (!response.ok) throw new FinancialAttachmentStorageError();
      const header = encrypted.subarray(0, encrypted.indexOf(10)).toString("utf8").split(":");
      return { storageKey: contract.key, cipherSize: encrypted.length, cipherSha256: hash(encrypted), keyVersion: header[1] };
    } catch { throw new FinancialAttachmentStorageError(); }
  }
  async put(identity:AttachmentObjectIdentity,bytes:Uint8Array,ttl:number){return this.putContract(this.contract(identity),bytes,ttl);}
  async read(identity: AttachmentObjectIdentity, expected: { cipherSize: number; cipherSha256: string; keyVersion: string }, ttl: number) {
    this.requireKeys();
    try { const contract=this.contract(identity),bytes = await this.encrypted(contract, ttl);
      if (bytes.length !== expected.cipherSize || hash(bytes) !== expected.cipherSha256 || bytes.subarray(0, bytes.indexOf(10)).toString("utf8").split(":")[1] !== expected.keyVersion) throw new FinancialAttachmentStorageError();
      return this.plain(contract, bytes);
    } catch { throw new FinancialAttachmentStorageError(); }
  }
  async putPart(identity:AttachmentObjectIdentity,index:number,parts:FinancialAttachmentParts,bytes:Uint8Array,ttl:number){
    try{return await this.putContract(financialAttachmentPartContract(identity,index,parts),bytes,ttl);}catch{throw new FinancialAttachmentStorageError();}
  }
  async readPart(identity:AttachmentObjectIdentity,index:number,parts:FinancialAttachmentParts,ttl:number){
    this.requireKeys();try{const contract=financialAttachmentPartContract(identity,index,parts);return this.plain(contract,await this.encrypted(contract,ttl));}catch{throw new FinancialAttachmentStorageError();}
  }
}
