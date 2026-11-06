import { R2StorageProvider } from "@/platform/providers/real";
import { DocumentObjectStore } from "@/modules/documents/infrastructure/document-object-store";
import { storageFixtureEnvironment } from "./storage-fixture-config";

export function documentFixtureObjects(serverOrigin: string) {
  const server = new URL(serverOrigin), database = new URL(process.env.DATABASE_URL ?? "invalid:");
  if (process.env.VERCEL || process.env.VERCEL_ENV || !["127.0.0.1", "localhost", "[::1]"].includes(server.hostname) || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) throw Error("Owned browser storage transport required");
  const transport: typeof fetch = async (input, init) => {
    const signed = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (signed.origin !== "https://alvillas-e2e-local.r2.cloudflarestorage.com" || init?.method !== "GET") throw Error("Read-only owned storage transport required");
    const url = new URL("/__alvillas_e2e/storage-object", server); url.searchParams.set("url", signed.href);
    return fetch(url, { ...init, credentials: "omit", headers: { "x-alvillas-e2e-storage": storageFixtureEnvironment.R2_SECRET_ACCESS_KEY } });
  };
  return new DocumentObjectStore(new R2StorageProvider(storageFixtureEnvironment), transport);
}
