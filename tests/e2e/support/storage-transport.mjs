import { createHash } from "node:crypto";
import process from "node:process";
import { URL } from "node:url";

// A network-boundary fixture, loaded only by the local Playwright server.
// App authentication, authorization, API handlers and PostgreSQL remain real.
const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (process.env.VERCEL || process.env.VERCEL_ENV || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) ||
  process.env.R2_ACCOUNT_ID !== "alvillas-e2e-local") throw new Error("Local storage fixture requires an isolated test server");
const objects = new Map();
const realFetch = globalThis.fetch;
// Intercept only the object fixture origin; all other fetch calls retain their
// original implementation. Opt-in HTTP fault gates load separately below.
globalThis.fetch = async (input, init) => {
  const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (target.origin !== "https://alvillas-e2e-local.r2.cloudflarestorage.com") return realFetch(input, init);
  const request = new globalThis.Request(input, init);
  const url = new URL(request.url), key = url.pathname;
  if (!url.searchParams.get("X-Amz-Credential")?.startsWith("local-e2e-access/") || !/^[a-f0-9]{64}$/u.test(url.searchParams.get("X-Amz-Signature") ?? ""))
    return new globalThis.Response(null, { status: 403 });
  if (request.method === "PUT") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return new globalThis.Response(null, { status: 413 });
    objects.set(key, { bytes, contentType: request.headers.get("content-type") ?? "application/octet-stream" });
    return new globalThis.Response(null, { status: 200 });
  }
  if (request.method === "DELETE") { objects.delete(key); return new globalThis.Response(null, { status: 204 }); }
  const object = objects.get(key);
  if (!object) return new globalThis.Response(null, { status: 404 });
  return new globalThis.Response(new Uint8Array(object.bytes), { status: 200, headers: { "Content-Type": object.contentType,
    "Content-Length": String(object.bytes.length), ETag: createHash("sha256").update(object.bytes).digest("hex") } });
};

await import("./network-gates.mjs");
