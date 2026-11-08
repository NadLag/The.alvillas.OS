import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FinancialAttachmentObjectStore } from "@/modules/finance/infrastructure/financial-attachment-storage";
import { decryptBytes } from "@/platform/auth/secret-encryption";
import { financialAttachmentEncryptionContext } from "@/modules/finance/domain/financial-attachment";
import { financialAttachmentUploadChunkBytes,financialAttachmentPartContract } from "@/modules/finance/domain/financial-attachment-parts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = Buffer.from("%PDF-1.7\nDedicated original receipt\n%%EOF\n"), env: NodeJS.ProcessEnv = { NODE_ENV: "test", ENCRYPTION_KEYS: "one:" + randomBytes(32).toString("base64") };
  const identity = { organizationId: randomUUID(), transactionId: randomUUID(), id: randomUUID(), contentType: "application/pdf", fileSize: bytes.length, sha256: hash(bytes) };
  const objects = new Map<string, Uint8Array>(), requests: { method: string; headers: Headers; key: string }[] = [];
  const storage = { createSignedUploadUrl: ({ key }: { key: string }) => Promise.resolve({ url: "https://storage.example.test/" + key }),
    createSignedDownloadUrl: ({ key }: { key: string; expiresInSeconds: number }) => Promise.resolve({ url: "https://storage.example.test/" + key }) };
  const transport: typeof fetch = (url, init) => {
    const key = typeof url === "string" ? url : url instanceof URL ? url.href : url.url, method = init?.method ?? "GET", headers = new Headers(init?.headers); requests.push({ method, headers, key });
    if (method === "PUT") { if (objects.has(key)) return Promise.resolve(new Response(null, { status: 412 }));
      objects.set(key, new Uint8Array(init?.body as Uint8Array)); return Promise.resolve(new Response(null, { status: 200 })); }
    const value = objects.get(key); return Promise.resolve(value ? new Response(new Uint8Array(value)) : new Response(null, { status: 404 }));
  };
  return { bytes, env, identity, objects, requests, storage, transport, store: new FinancialAttachmentObjectStore(storage, transport, env) };
}
describe("original encrypted financial attachment storage", () => {
  it("stores ciphertext with conditional creation and recovers the exact original bytes", async () => {
    const f = fixture(), saved = await f.store.put(f.identity, f.bytes, 30), ciphertext = [...f.objects.values()][0];
    expect(Buffer.from(ciphertext).includes(f.bytes)).toBe(false); expect(f.requests.map(row => row.method)).toEqual(["PUT"]);
    expect(f.requests[0].headers.get("if-none-match")).toBe("*"); expect(saved.cipherSha256).toBe(hash(ciphertext));
    expect(decryptBytes(ciphertext, financialAttachmentEncryptionContext(f.identity), f.env)).toEqual(f.bytes);
    expect(await f.store.read(f.identity, saved, 30)).toEqual(f.bytes);
  });
  it("a repeated PUT reads and verifies the retained original ciphertext without replacing it or retrying HTTP", async () => {
    const f = fixture(), first = await f.store.put(f.identity, f.bytes, 30), original = Buffer.from([...f.objects.values()][0]);
    const repeated = await f.store.put(f.identity, f.bytes, 30); expect(repeated).toEqual(first);
    expect(Buffer.from([...f.objects.values()][0])).toEqual(original); expect(f.requests.map(row => row.method)).toEqual(["PUT", "PUT", "GET"]);
  });
  it("does not retry or overwrite an object after an acknowledgement is lost", async () => {
    const f = fixture(); let lost = false;
    const transport: typeof fetch = async (url, init) => { const response = await f.transport(url, init); if (!lost && init?.method === "PUT") { lost = true; throw Error("local lost acknowledgement"); } return response; };
    const store = new FinancialAttachmentObjectStore(f.storage, transport, f.env);
    await expect(store.put(f.identity, f.bytes, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
    expect(f.requests).toHaveLength(1); const original = Buffer.from([...f.objects.values()][0]);
    await store.put(f.identity, f.bytes, 30); expect(Buffer.from([...f.objects.values()][0])).toEqual(original);
    expect(f.requests.map(row => row.method)).toEqual(["PUT", "PUT", "GET"]);
  });
  it("requires persistent configured encryption keys rather than the authentication fallback", async () => {
    const f = fixture(), store = new FinancialAttachmentObjectStore(f.storage, f.transport, { NODE_ENV: "test", AUTH_SECRET: "not-a-persistent-financial-key" });
    await expect(store.put(f.identity, f.bytes, 30)).rejects.toThrow("financial_attachment_storage_unavailable"); expect(f.requests).toHaveLength(0);
  });
  it.each(["sha256", "fileSize"] as const)("rejects mismatched %s before making a storage request", async field => {
    const f = fixture(), identity = { ...f.identity, [field]: field === "sha256" ? "a".repeat(64) : f.bytes.length + 1 };
    await expect(f.store.put(identity, f.bytes, 30)).rejects.toThrow("financial_attachment_storage_unavailable"); expect(f.requests).toHaveLength(0);
  });
  it.each(["cipherSize", "cipherSha256", "keyVersion"] as const)("requires the recorded original %s on read", async field => {
    const f = fixture(), saved = await f.store.put(f.identity, f.bytes, 30), wrong = { ...saved, [field]: field === "cipherSize" ? saved.cipherSize + 1 : "incorrect" };
    await expect(f.store.read(f.identity, wrong, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
  });
  it.each(["organizationId", "transactionId", "id"] as const)("authenticates %s even when storage returns another original object", async field => {
    const f = fixture(), saved = await f.store.put(f.identity, f.bytes, 30), ciphertext = [...f.objects.values()][0];
    const store = new FinancialAttachmentObjectStore(f.storage, () => Promise.resolve(new Response(new Uint8Array(ciphertext))), f.env);
    await expect(store.read({ ...f.identity, [field]: randomUUID() }, saved, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
  });
  it("supports retained-key rotation while rejecting an unavailable historical key", async () => {
    const f = fixture(), saved = await f.store.put(f.identity, f.bytes, 30), next = "two:" + randomBytes(32).toString("base64");
    expect(await new FinancialAttachmentObjectStore(f.storage, f.transport, { NODE_ENV: "test", ENCRYPTION_KEYS: next + "," + f.env.ENCRYPTION_KEYS }).read(f.identity, saved, 30)).toEqual(f.bytes);
    await expect(new FinancialAttachmentObjectStore(f.storage, f.transport, { NODE_ENV: "test", ENCRYPTION_KEYS: next }).read(f.identity, saved, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
  });
  it("rejects mutated original ciphertext", async () => {
    const f = fixture(), saved = await f.store.put(f.identity, f.bytes, 30), [key, bytes] = [...f.objects][0];
    const changed = new Uint8Array(bytes); changed[changed.length - 1] ^= 1; f.objects.set(key, changed);
    await expect(f.store.read(f.identity, saved, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
    await expect(f.store.put(f.identity, f.bytes, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
  });
  it("bounds object responses before accepting oversized retained data", async () => {
    const f = fixture(), saved = await f.store.put(f.identity, f.bytes, 30), store = new FinancialAttachmentObjectStore(f.storage,
      () => Promise.resolve(new Response(new Uint8Array(f.bytes.length + 257))), f.env);
    await expect(store.read(f.identity, saved, 30)).rejects.toThrow("financial_attachment_storage_unavailable");
  });
});

function partFixture(){const f=fixture(),first=Buffer.alloc(financialAttachmentUploadChunkBytes,97),last=Buffer.alloc(17,98),bytes=Buffer.concat([first,last]),identity={...f.identity,fileSize:bytes.length,sha256:hash(bytes)},parts={schemaVersion:1 as const,chunkBytes:financialAttachmentUploadChunkBytes,hashes:[hash(first),hash(last)]};return{...f,first,last,bytes,identity,parts};}
describe("original encrypted financial multipart storage",()=>{
 it("stores only conditionally created authenticated parts and reads exact bounded originals",async()=>{
  const f=partFixture(),saved=await f.store.putPart(f.identity,0,f.parts,f.first,30),ciphertext=[...f.objects.values()][0],contract=financialAttachmentPartContract(f.identity,0,f.parts);expect(saved.storageKey).toBe(contract.key);expect(saved.cipherSha256).toBe(hash(ciphertext));expect(Buffer.from(ciphertext).includes(f.first)).toBe(false);expect(f.requests[0].headers.get("if-none-match")).toBe("*");expect(decryptBytes(ciphertext,contract.context,f.env)).toEqual(f.first);expect(await f.store.readPart(f.identity,0,f.parts,30)).toEqual(f.first);
 });
 it("retains the original part after a lost acknowledgement without automatic HTTP retries",async()=>{
  const f=partFixture();let lost=false;const transport:typeof fetch=async(url,init)=>{const response=await f.transport(url,init);if(!lost&&init?.method==="PUT"){lost=true;throw Error("Owned lost part acknowledgement");}return response;},store=new FinancialAttachmentObjectStore(f.storage,transport,f.env);
  await expect(store.putPart(f.identity,0,f.parts,f.first,30)).rejects.toThrow("financial_attachment_storage_unavailable");expect(f.requests).toHaveLength(1);const original=Buffer.from([...f.objects.values()][0]),recovered=await store.putPart(f.identity,0,f.parts,f.first,30);expect(recovered.cipherSha256).toBe(hash(original));expect(Buffer.from([...f.objects.values()][0])).toEqual(original);expect(f.requests.map(request=>request.method)).toEqual(["PUT","PUT","GET"]);
 });
 it.each(["organizationId","transactionId","id","contentType","sha256"]as const)("authenticates original %s even when storage substitutes another part",async field=>{
  const f=partFixture();await f.store.putPart(f.identity,0,f.parts,f.first,30);const ciphertext=[...f.objects.values()][0],store=new FinancialAttachmentObjectStore(f.storage,()=>Promise.resolve(new Response(new Uint8Array(ciphertext))),f.env),changed={...f.identity,[field]:field==="contentType"?"image/png":field==="sha256"?hash(Buffer.from("another immutable original")):randomUUID()};await expect(store.readPart(changed,0,f.parts,30)).rejects.toThrow("financial_attachment_storage_unavailable");
 });
 it("authenticates a changed whole-file size without relying on different part lengths",async()=>{
  const f=partFixture();await f.store.putPart(f.identity,0,f.parts,f.first,30);const ciphertext=[...f.objects.values()][0],store=new FinancialAttachmentObjectStore(f.storage,()=>Promise.resolve(new Response(new Uint8Array(ciphertext))),f.env);expect(financialAttachmentPartContract({...f.identity,fileSize:f.identity.fileSize+1},0,f.parts).size).toBe(f.first.length);await expect(store.readPart({...f.identity,fileSize:f.identity.fileSize+1},0,f.parts,30)).rejects.toThrow("financial_attachment_storage_unavailable");
 });
 it("cannot substitute equal-size identical-content parts at another index",async()=>{
  const f=partFixture(),identity={...f.identity,fileSize:2*f.first.length,sha256:hash(Buffer.concat([f.first,f.first]))},parts={...f.parts,hashes:[hash(f.first),hash(f.first)]};await f.store.putPart(identity,0,parts,f.first,30);const ciphertext=[...f.objects.values()][0],store=new FinancialAttachmentObjectStore(f.storage,()=>Promise.resolve(new Response(new Uint8Array(ciphertext))),f.env);await expect(store.readPart(identity,1,parts,30)).rejects.toThrow("financial_attachment_storage_unavailable");
 });
 it("keeps original whole-file ciphertext and part ciphertext in different authenticated protocols",async()=>{
  const f=partFixture(),identity={...f.identity,fileSize:f.first.length,sha256:hash(f.first)},parts={...f.parts,hashes:[hash(f.first)]},whole=await f.store.put(identity,f.first,30),wholeCiphertext=[...f.objects.values()][0],substituted=new FinancialAttachmentObjectStore(f.storage,()=>Promise.resolve(new Response(new Uint8Array(wholeCiphertext))),f.env);await expect(substituted.readPart(identity,0,parts,30)).rejects.toThrow("financial_attachment_storage_unavailable");const part=await f.store.putPart(identity,0,parts,f.first,30),partCiphertext=[...f.objects.values()][1],substitutedPart=new FinancialAttachmentObjectStore(f.storage,()=>Promise.resolve(new Response(new Uint8Array(partCiphertext))),f.env);expect(whole.cipherSize).toBe(part.cipherSize);await expect(substitutedPart.read(identity,part,30)).rejects.toThrow("financial_attachment_storage_unavailable");
 });
 it("does not write a malformed part or accept mutated retained ciphertext",async()=>{
  const f=partFixture();await expect(f.store.putPart(f.identity,0,f.parts,f.last,30)).rejects.toThrow("financial_attachment_storage_unavailable");expect(f.requests).toHaveLength(0);await f.store.putPart(f.identity,0,f.parts,f.first,30);const[key,bytes]=[...f.objects][0],changed=new Uint8Array(bytes);changed[changed.length-1]^=1;f.objects.set(key,changed);await expect(f.store.readPart(f.identity,0,f.parts,30)).rejects.toThrow("financial_attachment_storage_unavailable");await expect(f.store.putPart(f.identity,0,f.parts,f.first,30)).rejects.toThrow("financial_attachment_storage_unavailable");
 });
});
