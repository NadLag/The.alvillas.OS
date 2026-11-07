import { R2StorageProvider } from "@/platform/providers/real";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";
import { storageFixtureEnvironment } from "./storage-fixture-config";

export function documentFixtureObjects(serverOrigin: string, options: { write?: true } = {}) {
  const server = new URL(serverOrigin), database = new URL(process.env.DATABASE_URL ?? "invalid:");
  if (process.env.VERCEL || process.env.VERCEL_ENV || !["127.0.0.1", "localhost", "[::1]"].includes(server.hostname) || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) throw Error("Owned browser storage transport required");
  const transport: typeof fetch = async (input, init) => {
    const signed = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const writing = options.write && init?.method === "PUT";
    if (signed.origin !== "https://alvillas-e2e-local.r2.cloudflarestorage.com" || init?.method !== "GET" && !writing) throw Error("Read-only owned storage transport required");
    if (writing && (new Headers(init?.headers).get("if-none-match") !== "*" || new Headers(init?.headers).get("content-type") !== "application/octet-stream")) throw Error("Actual conditional encrypted-object write required");
    const url = new URL(writing ? "/__alvillas_e2e/storage-put" : "/__alvillas_e2e/storage-object", server); url.searchParams.set("url", signed.href);
    return fetch(url, { ...init, credentials: "omit", headers: { ...writing ? { "content-type": "application/octet-stream", "if-none-match": "*" } : {}, "x-alvillas-e2e-storage": storageFixtureEnvironment.R2_SECRET_ACCESS_KEY } });
  };
  return new DocumentObjectStore(new R2StorageProvider(storageFixtureEnvironment), transport);
}
