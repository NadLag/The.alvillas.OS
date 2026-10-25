import { createHash } from "node:crypto";
import { expect as playwrightExpect, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";
import { storedFieldData } from "../../tests/e2e/support/field-storage";

const expect = playwrightExpect.configure({ timeout: 30000 });
export async function prepareStagingFieldWorker(context: BrowserContext, page: Page, sha: string,
  fixture: { actorId: string; actorPersonId: string; organizationId: string }) {
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  expect(await (await context.request.get("/api/auth/session")).json()).toMatchObject({ user: { id: fixture.actorId,
    personId: fixture.actorPersonId, organizationId: fixture.organizationId, securitySetupRequired: false } });
  await page.goto("/en/app/field"); await expect(page.getByTestId("field-page")).toBeVisible();
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
  const response = await context.request.get("/sw.js"); expect(response.status()).toBe(200);
  const workerDigest = createHash("sha256").update(await response.body()).digest("hex");
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  return { preparedSha: sha, origin: "https://the-alvillas-os-staging.vercel.app", ...fixture, deviceId, nativeVersion: 30 as const,
    workerDigest, completed: true as const, authenticated: true as const, taskMutations: 0, operations: 0, photos: 0 };
}
