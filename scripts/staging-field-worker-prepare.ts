import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import { z } from "zod";
import { storedFieldData } from "../tests/e2e/support/field-storage";

const expect = playwrightExpect.configure({ timeout: 30000 }), origin = "https://the-alvillas-os-staging.vercel.app";
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE), file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const profile = await realpath(z.string().min(1).parse(process.env.STAGING_PROFILE_DIRECTORY)), parent = await realpath(dirname(state));
const fixture = z.object({ organizationId: z.uuid(), actorId: z.uuid(), actorPersonId: z.uuid() })
  .parse(JSON.parse(await readFile(z.string().min(1).parse(process.env.STAGING_OPERATIONS_FIXTURE_FILE), "utf8")));
if (dirname(profile) !== parent || dirname(await realpath(file)) !== parent || basename(profile) !== "staging-field-proxy-offline-native" ||
  (await readdir(profile)).length || Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")))).length) throw new Error("A new private native worker profile is required");
const saved = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) })) }).parse(JSON.parse(await readFile(state, "utf8")));
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium", baseURL: origin,
  ignoreDefaultArgs: ["--disable-background-networking"], viewport: { width: 1440, height: 1000 } });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000);
try {
  await context.addCookies(saved.cookies.filter(cookie => cookie.domain.replace(/^\./u, "") === new URL(origin).hostname));
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  expect(await (await context.request.get("/api/auth/session")).json()).toMatchObject({ user: { id: fixture.actorId,
    personId: fixture.actorPersonId, organizationId: fixture.organizationId, securitySetupRequired: false } });
  const page = context.pages()[0] ?? await context.newPage(); await page.goto("/en/app/field"); await expect(page.getByTestId("field-page")).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(locale => caches.match(`/${locale}/offline/field`)))).every(Boolean))).toBe(true);
  expect(await storedFieldData(page)).toEqual([]); expect(await storedFieldData(page, "photos")).toEqual([]);
  const readMetadata = async () => z.array(z.object({ key: z.string(), value: z.string() })).parse(await storedFieldData(page, "metadata"));
  await expect.poll(async () => (await readMetadata()).find(row => row.key === "identity")?.value).toBe(`${fixture.organizationId}:${fixture.actorId}`);
  const metadata = await readMetadata();
  expect(metadata.find(row => row.key === "identity")?.value).toBe(`${fixture.organizationId}:${fixture.actorId}`);
  const deviceId = z.uuid().parse(metadata.find(row => row.key === "device")?.value);
  const nativeVersion = await page.evaluate(() => new Promise<number>((resolve, reject) => { const open = indexedDB.open("alvillas.field.v1");
    open.onerror = () => reject(new Error("Native field database unavailable")); open.onsuccess = () => { const db = open.result; resolve(db.version); db.close(); }; }));
  expect(nativeVersion).toBe(30);
  const response = await context.request.get("/sw.js"); expect(response.status()).toBe(200); const workerDigest = createHash("sha256").update(await response.body()).digest("hex");
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  await writeFile(file, JSON.stringify({ preparedSha: sha, origin, ...fixture, deviceId, nativeVersion, workerDigest,
    completed: true, authenticated: true, taskMutations: 0, operations: 0, photos: 0 }, null, 2));
  console.log(JSON.stringify({ sha, authenticatedNativeWorkerPrepared: true, nativeDatabaseVersion: nativeVersion, taskMutations: 0 }));
} catch { throw new Error("Native worker preparation incomplete; preserve the private profile for read-only recovery"); }
finally { await context.close(); }
