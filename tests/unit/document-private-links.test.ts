import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { R2StorageProvider } from "@/platform/providers/real";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";

function fixture() {
  const bytes = Buffer.from("%PDF-1.7\nPrivate original document\n%%EOF\n"), env = { NODE_ENV: "test" as const, ENCRYPTION_KEYS: "short-links:" + randomBytes(32).toString("base64") },
    identity = { organizationId: randomUUID(), documentId: randomUUID(), admissionId: randomUUID(), contentType: "application/pdf" as const,
      fileSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    provider = new R2StorageProvider({ R2_ACCOUNT_ID: "owned-link-contract", R2_ACCESS_KEY_ID: "owned-access", R2_SECRET_ACCESS_KEY: "owned-test-signing", R2_BUCKET: "private-documents" }, () => new Date("2026-11-06T12:00:00.000Z")),
    requests: Array<{ url: URL; method: string }> = [], objects = new Map<string, Uint8Array>(), transport: typeof fetch = (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), method = init.method ?? "GET";
      requests.push({ url, method }); expect(url.hostname).toBe("owned-link-contract.r2.cloudflarestorage.com");
      if (method === "PUT") { expect(new Headers(init.headers).get("if-none-match")).toBe("*");
        if (objects.has(url.pathname)) return Promise.resolve(new Response(null, { status: 412 }));
        objects.set(url.pathname, new Uint8Array(init.body as Uint8Array)); return Promise.resolve(new Response(null, { status: 200 })); }
      const stored = objects.get(url.pathname); return Promise.resolve(stored ? new Response(new Uint8Array(stored)) : new Response(null, { status: 404 }));
    };
  return { bytes, identity, provider, requests, objects, store: new DocumentObjectStore(provider, transport, env) };
}

describe("private document links use the actual R2 signing contract", () => {
  it.each([1, 29, 30, 300])("honors a configured %s second download lifetime without changing encrypted original bytes", async seconds => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, seconds), original = Buffer.from([...f.objects.values()][0]);
    expect(await f.store.read(f.identity, stored, seconds)).toEqual(f.bytes);
    const request = f.requests.at(-1)!; expect(request.method).toBe("GET"); expect(request.url.searchParams.get("X-Amz-Expires")).toBe(String(seconds));
    expect(request.url.searchParams.get("X-Amz-Date")).toBe("20261106T120000Z"); expect(request.url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/u);
    expect(request.url.pathname).toBe("/private-documents/" + stored.storageKey); expect(request.url.href).not.toContain("owned-test-signing");
    expect(Buffer.from([...f.objects.values()][0])).toEqual(original); expect(original.includes(f.bytes)).toBe(false);
  });
  it.each([0, -1, 1.5, 301, NaN, Infinity])("rejects invalid document expiry %s before a link or request can be issued", async seconds => {
    const f = fixture(), stored = await f.store.put(f.identity, f.bytes, 30), sign = vi.spyOn(f.provider, "createSignedDownloadUrl"), before = f.requests.length;
    await expect(f.store.read(f.identity, stored, seconds)).rejects.toThrow("document_storage_unavailable"); expect(sign).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(before);
  });
  it.each([0, -1, 1.5, 901, NaN, Infinity])("keeps the shared provider expiry boundary for invalid %s", seconds => {
    const f = fixture(); expect(() => f.provider.createSignedDownloadUrl({ key: "private/original.encrypted", expiresInSeconds: seconds })).toThrow("Invalid private document link duration");
    expect(f.requests).toHaveLength(0);
  });
});
