import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";
import { documentEncryptionContext, documentObjectKey } from "@/modules/documents/domain/document-object";
import { decryptBytes } from "@/platform/auth/secret-encryption";
import { documentUploadChunkBytes } from "@/modules/documents/domain/document-upload-parts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = Buffer.from("%PDF-1.7\nOwner agreement version one\n%%EOF\n"), env = { NODE_ENV: "test" as const, ENCRYPTION_KEYS: "archive-one:" + randomBytes(32).toString("base64") };
  const identity = { organizationId: randomUUID(), documentId: randomUUID(), admissionId: randomUUID(), contentType: "application/pdf" as const, fileSize: bytes.length, sha256: sha256(bytes) };
  const objects = new Map<string, Uint8Array>(), requests: { method: string; init: RequestInit }[] = [];
  const storage = { createSignedUploadUrl: ({ key }: { key: string }) => Promise.resolve({ url: "https://archive.example.test/" + key }),
    createSignedDownloadUrl: ({ key }: { key: string; expiresInSeconds: number }) => Promise.resolve({ url: "https://archive.example.test/" + key }) };
  const transport: typeof fetch = (input, init = {}) => {
    const key = typeof input === "string" ? input : input instanceof URL ? input.href : input.url, method = init.method ?? "GET"; requests.push({ method, init });
    if (method === "PUT") { if (objects.has(key)) return Promise.resolve(new Response(null, { status: 412 }));
      objects.set(key, new Uint8Array(init.body as Uint8Array)); return Promise.resolve(new Response(null, { status: 200 })); }
    const value = objects.get(key); return Promise.resolve(value ? new Response(new Uint8Array(value)) : new Response(null, { status: 404 }));
  };
  return { bytes, env, identity, storage, transport, objects, requests, store: new DocumentObjectStore(storage, transport, env) };
}

describe("private versioned document objects", () => {
  it("stores authenticated ciphertext in its native document namespace and never exposes plaintext to storage", async () => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30), cipher = [...f.objects.values()][0];
    expect(stored.storageKey).toBe(documentObjectKey(f.identity)); expect(Buffer.from(cipher).includes(f.bytes)).toBe(false);
    expect(decryptBytes(cipher, documentEncryptionContext(f.identity), f.env)).toEqual(f.bytes);
    expect(new Headers(f.requests[0].init.headers).get("if-none-match")).toBe("*");
    expect(await f.store.read(f.identity, stored, 30)).toEqual(f.bytes);
    expect(f.requests.every(request => request.init.redirect === "error" && request.init.signal instanceof AbortSignal)).toBe(true);
    expect(f.requests.at(-1)?.init.cache).toBe("no-store");
  });
  it("recovers the first ciphertext after a lost PUT acknowledgement without automatic retries or replacement", async () => {
    const f = fixture(); let lose = true;
    const transport: typeof fetch = async (url, init) => { const response = await f.transport(url, init); if (lose && init?.method === "PUT") { lose = false; throw Error("lost acknowledgement"); } return response; };
    const store = new DocumentObjectStore(f.storage, transport, f.env);
    await expect(store.put(f.identity, f.bytes, 30)).rejects.toThrow("document_storage_unavailable");
    expect(f.requests.map(request => request.method)).toEqual(["PUT"]); const first = Buffer.from([...f.objects.values()][0]);
    const recovered = await store.put(f.identity, f.bytes, 30); expect(recovered.cipherSha256).toBe(sha256(first));
    expect(Buffer.from([...f.objects.values()][0])).toEqual(first); expect(f.requests.map(request => request.method)).toEqual(["PUT", "PUT", "GET"]);
  });
  it.each(["organizationId", "documentId", "admissionId"] as const)("rejects cross-%s ciphertext even if the object server redirects its content", async field => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30), cipher = [...f.objects.values()][0];
    const store = new DocumentObjectStore(f.storage, () => Promise.resolve(new Response(new Uint8Array(cipher))), f.env);
    await expect(store.read({ ...f.identity, [field]: randomUUID() }, stored, 30)).rejects.toThrow("document_storage_unavailable");
  });
  it.each(["cipherSize", "cipherSha256", "keyVersion"] as const)("requires the recorded %s rather than trusting object headers", async field => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30);
    await expect(f.store.read(f.identity, { ...stored, [field]: field === "cipherSize" ? stored.cipherSize + 1 : "invalid" }, 30)).rejects.toThrow("document_storage_unavailable");
  });
  it("retains old encrypted versions across key rotation and refuses a missing historical key", async () => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30), rotated = "archive-two:" + randomBytes(32).toString("base64");
    expect(await new DocumentObjectStore(f.storage, f.transport, { NODE_ENV:"test", ENCRYPTION_KEYS: rotated + "," + f.env.ENCRYPTION_KEYS }).read(f.identity, stored, 30)).toEqual(f.bytes);
    await expect(new DocumentObjectStore(f.storage, f.transport, { NODE_ENV:"test", ENCRYPTION_KEYS: rotated }).read(f.identity, stored, 30)).rejects.toThrow("document_storage_unavailable");
  });
  it("rejects mutated original ciphertext on download and conditional admission recovery", async () => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30), [key, original] = [...f.objects][0], changed = new Uint8Array(original); changed[changed.length - 1] ^= 1; f.objects.set(key, changed);
    await expect(f.store.read(f.identity, stored, 30)).rejects.toThrow("document_storage_unavailable");
    await expect(f.store.put(f.identity, f.bytes, 30)).rejects.toThrow("document_storage_unavailable"); expect(f.objects.get(key)).toEqual(changed);
  });
  it("bounds the response before accepting oversized ciphertext", async () => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30);
    const store = new DocumentObjectStore(f.storage, () => Promise.resolve(new Response(new Uint8Array(f.bytes.length + 257))), f.env);
    await expect(store.read(f.identity, stored, 30)).rejects.toThrow("document_storage_unavailable");
  });
  it("requires persistent encryption keys and rejects path injection before transport", async () => {
    const f = fixture();
    await expect(new DocumentObjectStore(f.storage, f.transport, { NODE_ENV:"test", AUTH_SECRET: "not-the-archive-key" }).put(f.identity, f.bytes, 30)).rejects.toThrow("document_storage_unavailable");
    await expect(f.store.put({ ...f.identity, documentId: "../../another-document" }, f.bytes, 30)).rejects.toThrow("document_storage_unavailable");
    expect(f.requests).toHaveLength(0);
  });
  it.each(["fileSize", "sha256", "contentType"] as const)("authenticates declared %s as well as native IDs", async field => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30), cipher = [...f.objects.values()][0];
    const identity = { ...f.identity, ...(field === "fileSize" ? { fileSize: f.identity.fileSize + 1 } : field === "sha256" ? { sha256: "a".repeat(64) } : { contentType: "image/png" as const }) };
    await expect(new DocumentObjectStore(f.storage, () => Promise.resolve(new Response(new Uint8Array(cipher))), f.env).read(identity, stored, 30)).rejects.toThrow("document_storage_unavailable");
  });
});

describe("immutable encrypted document upload parts",()=>{
  it("stores parts in the original admission namespace and preserves first ciphertext after a lost acknowledgement",async()=>{
    const f=fixture(),parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:[sha256(f.bytes)]};let lost=true;
    const transport:typeof fetch=async(url,init)=>{const response=await f.transport(url,init);if(lost&&init?.method==="PUT"){lost=false;throw Error("lost part acknowledgement");}return response;};
    const store=new DocumentObjectStore(f.storage,transport,f.env);await expect(store.putPart(f.identity,0,parts,f.bytes,30)).rejects.toThrow("document_storage_unavailable");expect(f.requests.map(request=>request.method)).toEqual(["PUT"]);
    const retained=Buffer.from([...f.objects.values()][0]);const result=await store.putPart(f.identity,0,parts,f.bytes,30);expect(result.storageKey).toContain(`/admissions/${f.identity.admissionId}/parts/0.encrypted`);
    expect(Buffer.from([...f.objects.values()][0])).toEqual(retained);expect(await store.readPart(f.identity,0,parts,30)).toEqual(f.bytes);expect(Buffer.from(retained).includes(f.bytes)).toBe(false);
  });
  it("rejects a changed part hash or admission even when the object server substitutes original ciphertext",async()=>{
    const f=fixture(),parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:[sha256(f.bytes)]};await f.store.putPart(f.identity,0,parts,f.bytes,30);const cipher=[...f.objects.values()][0],store=new DocumentObjectStore(f.storage,()=>Promise.resolve(new Response(new Uint8Array(cipher))),f.env);
    await expect(store.readPart({...f.identity,admissionId:randomUUID()},0,parts,30)).rejects.toThrow("document_storage_unavailable");await expect(store.readPart(f.identity,0,{...parts,hashes:["a".repeat(64)]},30)).rejects.toThrow("document_storage_unavailable");
    await expect(store.read(f.identity,{cipherSize:cipher.length,cipherSha256:sha256(cipher),keyVersion:"archive-one"},30)).rejects.toThrow("document_storage_unavailable");
  });
  it("refuses malformed framing and mismatched bytes before any transport",async()=>{
    const f=fixture(),parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:[sha256(f.bytes)]};
    await expect(f.store.putPart(f.identity,1,parts,f.bytes,30)).rejects.toThrow("document_storage_unavailable");await expect(f.store.putPart(f.identity,0,{...parts,hashes:[...parts.hashes,...parts.hashes]},f.bytes,30)).rejects.toThrow("document_storage_unavailable");
    await expect(f.store.putPart(f.identity,0,parts,Buffer.from("different"),30)).rejects.toThrow("document_storage_unavailable");expect(f.requests).toHaveLength(0);
  });
  it("authenticates distinct part indices and rejects reordered ciphertext",async()=>{
    const f=fixture(),bytes=Buffer.concat([Buffer.alloc(documentUploadChunkBytes,97),f.bytes]),identity={...f.identity,fileSize:bytes.length,sha256:sha256(bytes)},parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:[sha256(bytes.subarray(0,documentUploadChunkBytes)),sha256(f.bytes)]};
    await f.store.putPart(identity,0,parts,bytes.subarray(0,documentUploadChunkBytes),30);await f.store.putPart(identity,1,parts,f.bytes,30);const entries=[...f.objects];f.objects.set(entries[0][0],entries[1][1]);f.objects.set(entries[1][0],entries[0][1]);
    await expect(f.store.readPart(identity,0,parts,30)).rejects.toThrow("document_storage_unavailable");await expect(f.store.readPart(identity,1,parts,30)).rejects.toThrow("document_storage_unavailable");
  });
});
