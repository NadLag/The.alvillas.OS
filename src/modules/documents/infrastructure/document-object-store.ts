import { createHash } from "node:crypto";
import { z } from "zod";
import { encryptBytes, decryptBytes } from "@/platform/auth/secret-encryption";
import type { StorageProvider } from "@/platform/providers";
import { privateUploadTransportTimeoutMs } from "@/platform/storage/upload-protocol";
import { readBoundedResponseBytes } from "@/platform/http/read-exact-response";
import { documentObjectKey, documentEncryptionContext, documentObjectIdentitySchema, documentCipherIdentitySchema,
  type DocumentObjectIdentity, type DocumentCipherIdentity } from "../domain/document-object";
import { DocumentStorageError } from "../domain/document-command";
import { documentPartContract,type DocumentUploadParts } from "../domain/document-upload-parts";

export type DocumentStorageProvider = StorageProvider & {
  createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }>;
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const lifetime = z.number().int().min(1).max(300);
type ObjectContract={key:string;context:string;size:number;sha256:string};

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
  private plain(contract:ObjectContract, cipher: Uint8Array) {
    const bytes = decryptBytes(cipher, contract.context, this.env);
    if (bytes.length !== contract.size || sha256(bytes) !== contract.sha256) throw new DocumentStorageError();
    return bytes;
  }
  private async retained(contract:ObjectContract, ttl: number) {
    const signed = await this.storage.createSignedDownloadUrl({ key: contract.key, expiresInSeconds: lifetime.parse(ttl) });
    const response = await this.transport(signed.url, { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
    if (!response.ok || !response.body) throw new DocumentStorageError();
    return Buffer.from(await readBoundedResponseBytes(response, contract.size + 256));
  }
  private async putContract(contract:ObjectContract,bytes:Uint8Array,ttl:number){
    try {
      this.requireKeys();lifetime.parse(ttl);
      if (bytes.length !== contract.size || sha256(bytes) !== contract.sha256) throw new DocumentStorageError();
      let cipher = encryptBytes(bytes, contract.context, this.env);
      this.keyVersion(cipher);
      const signed = await this.storage.createSignedUploadUrl({ key: contract.key, contentType: "application/octet-stream" });
      const response = await this.transport(signed.url, { method: "PUT", headers: { "content-type": "application/octet-stream", "if-none-match": "*" },
        body: new Uint8Array(cipher), redirect: "error", signal: AbortSignal.timeout(privateUploadTransportTimeoutMs) });
      if (response.status === 412) { cipher = await this.retained(contract, ttl); this.plain(contract, cipher); }
      else if (!response.ok) throw new DocumentStorageError();
      return { storageKey: contract.key, cipherSize: cipher.length, cipherSha256: sha256(cipher), keyVersion: this.keyVersion(cipher) };
    } catch { throw new DocumentStorageError(); }
  }
  private contract(identity:DocumentObjectIdentity){documentObjectIdentitySchema.parse(identity);return{key:documentObjectKey(identity),context:documentEncryptionContext(identity),size:identity.fileSize,sha256:identity.sha256};}
  async put(identity: DocumentObjectIdentity, bytes: Uint8Array, ttl: number) {
    try{return await this.putContract(this.contract(identity),bytes,ttl);}catch{throw new DocumentStorageError();}
  }
  async read(identity: DocumentObjectIdentity, expected: DocumentCipherIdentity, ttl: number) {
    try {
      this.requireKeys();const contract=this.contract(identity);documentCipherIdentitySchema.parse(expected);
      const cipher = await this.retained(contract, ttl);
      if (cipher.length !== expected.cipherSize || sha256(cipher) !== expected.cipherSha256 || this.keyVersion(cipher) !== expected.keyVersion) throw new DocumentStorageError();
      return this.plain(contract, cipher);
    } catch { throw new DocumentStorageError(); }
  }
  async putPart(identity:DocumentObjectIdentity,index:number,parts:DocumentUploadParts,bytes:Uint8Array,ttl:number){
    try{documentObjectIdentitySchema.parse(identity);return await this.putContract(documentPartContract(identity,index,parts),bytes,ttl);}catch{throw new DocumentStorageError();}
  }
  async readPart(identity:DocumentObjectIdentity,index:number,parts:DocumentUploadParts,ttl:number){
    try{this.requireKeys();documentObjectIdentitySchema.parse(identity);const contract=documentPartContract(identity,index,parts);return this.plain(contract,await this.retained(contract,ttl));}catch{throw new DocumentStorageError();}
  }
}
