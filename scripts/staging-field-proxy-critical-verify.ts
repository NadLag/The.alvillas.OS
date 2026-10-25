import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { storedFieldData } from "../tests/e2e/support/field-storage";
import { syncPushInputSchema } from "../src/modules/reservations/domain/sync-protocol";
import { fieldWorkSnapshotSchema } from "../src/modules/reservations/domain/field-pull";
import { blockStagingWorkerSync } from "./support/staging-worker-network";

const expect = playwrightExpect.configure({ timeout: 30000 }), origin = "https://the-alvillas-os-staging.vercel.app";
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE), file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE);
const profile = z.string().min(1).parse(process.env.STAGING_PROFILE_DIRECTORY);
const source = z.object({ accountKind: z.literal("dedicated-field-proxy-critical"), completed: z.literal(true), organizationId: z.uuid(),
  actorId: z.uuid(), actorPersonId: z.uuid(), supervisorId: z.uuid(), supervisorPersonId: z.uuid(),
  propertyName: z.string().regex(/^Automation acceptance aut-[a-f0-9]{8}$/u), tasks: z.array(z.object({ id: z.uuid(), assigned: z.literal(true), scopeGrantVerified: z.literal(true) })).length(1) })
  .parse(JSON.parse(await readFile(z.string().min(1).parse(process.env.STAGING_OPERATIONS_FIXTURE_FILE), "utf8")));
const fixture = { ...source, actorId: source.supervisorId, actorPersonId: source.supervisorPersonId, workerPersonId: source.actorPersonId };
const taskId = fixture.tasks[0].id;
if (Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(file, "utf8")))).length || (await readdir(profile)).length)
  throw new Error("Use a fresh dedicated critical-review profile; preserve existing keys and checkpoints");
const privateParent = await realpath(dirname(state)), profilePath = await realpath(profile);
if (dirname(profilePath) !== privateParent || dirname(await realpath(file)) !== privateParent || basename(profilePath) !== "staging-field-proxy-critical-native")
  throw new Error("Private dedicated critical-review files required");
const saved = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(), httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) })) }).parse(JSON.parse(await readFile(state, "utf8")));
const context = await chromium.launchPersistentContext(profilePath, { headless: true, channel: "chromium", baseURL: origin,
  args: ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], ignoreDefaultArgs: ["--disable-background-networking"], timezoneId: "America/Denver", viewport: { width: 1440, height: 1000 } });
const gate = await blockStagingWorkerSync(profilePath, origin);
const editor = await chromium.launch(), online = await editor.newContext({ baseURL: origin, storageState: state });
context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(90000); online.setDefaultTimeout(30000); online.setDefaultNavigationTimeout(90000);
const page = context.pages()[0] ?? await context.newPage(), edits = await online.newPage(), checks: Array<{ locale: string; width: number }> = [];
const errors: string[] = [], wire: Array<{ device: string; nonce: string; status: string }> = [];
const evidence: Record<string, unknown> = { sha, origin, ...fixture, taskId, checks, wire, completed: false, nativeWorkerTransportFault: true };
let phase = "authentication", originalNonce = "", reviewingNonce = "", holdSuccess = false, sending = false, lost = false, blockForUpgrade = true;
const checkpoint = () => writeFile(file, JSON.stringify({ ...evidence, phase, workerTransport: gate.state() }, null, 2));
const rows = z.array(z.object({ operation: z.object({ client_op_id: z.uuid(), type: z.string() }), syncStatus: z.string(), resolvedByClientOpId: z.uuid().optional(), result: z.object({ status: z.string() }).optional() }));
try {
  await context.addCookies(saved.cookies.filter(cookie => cookie.domain.replace(/^\./u, "") === new URL(origin).hostname));
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  expect(await (await context.request.get("/api/auth/session")).json()).toMatchObject({ user: { id: fixture.actorId, personId: fixture.actorPersonId, organizationId: fixture.organizationId, securitySetupRequired: false } });
  expect(fixture.workerPersonId).not.toBe(fixture.actorPersonId); page.on("pageerror", error => errors.push(error.message));
  await context.route("**/api/sync/push", async route => {
    try {
      if (blockForUpgrade) { await route.abort(); return; }
      const batch = syncPushInputSchema.parse(route.request().postDataJSON()), operation = batch.ops.find(op => op.type === "field_task.proxy_validate");
      if (!operation) throw new Error("Unexpected acceptance operation");
      if (holdSuccess && operation.client_op_id === reviewingNonce && sending) { await route.abort(); return; }
      if (holdSuccess && operation.client_op_id === reviewingNonce) sending = true;
      const response = await route.fetch(); expect(response.status()).toBe(200);
      const result = z.object({ results: z.array(z.object({ client_op_id: z.uuid(), status: z.string() })) }).parse(await response.json());
      wire.push(...result.results.map(item => ({ device: batch.device_id, nonce: item.client_op_id, status: item.status })));
      if (holdSuccess && operation.client_op_id === reviewingNonce) { expect(result.results[0].status).toBe("APPLIED"); lost = true; await route.abort(); }
      else await route.fulfill({ response });
    } catch { errors.push("supervisor_sync_route_unavailable"); await route.abort().catch(() => undefined); }
  });
  const cachedTask = async () => z.array(z.object({ task: fieldWorkSnapshotSchema })).parse(await storedFieldData(page, "proxyJobs")).filter(row => row.task.id === taskId);
  const form = page.getByTestId("field-proxy-form"), reason = form.locator('[name="reason"]'), checkboxes = form.getByRole("checkbox");
  await context.setOffline(false);
  await page.goto(`/en/app/field/validate/${taskId}`); await expect(page.getByTestId("field-proxy-page")).toContainText(fixture.propertyName);
  phase = "foreground-supervised-cache";
  evidence.waitingBeforeCachePreparation = await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting));
  await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
  await expect.poll(cachedTask).toHaveLength(1);
  evidence.cachePreparedByForegroundSync = true;
  phase = "cache-anonymous-offline-shells";
  await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(locale => caches.match(`/${locale}/offline/field`)))).every(Boolean))).toBe(true);
  phase = "persist-local-review-draft";
  await reason.fill("Offline supervisor confirms the dedicated employee's work"); await checkboxes.first().check();
  originalNonce = await form.locator('[name="idempotencyKey"]').inputValue(); evidence.originalNonce = originalNonce;
  evidence.originalVersion = Number(await form.locator('[name="expectedVersion"]').inputValue()); await checkpoint();
  await expect.poll(() => storedFieldData(page, "proxyDrafts")).toContainEqual(expect.objectContaining({ taskId,
    clientOpId: originalNonce, reason: "Offline supervisor confirms the dedicated employee's work",
    checklistItemIds: [await checkboxes.first().inputValue()] }));
  phase = "queue-original-review"; await context.setOffline(true);
  for (const checkbox of await checkboxes.all()) await checkbox.check();
  evidence.queued = true; await checkpoint(); await page.getByTestId("field-proxy-submit").focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("field-proxy-queued")).toBeVisible(); evidence.originalQueue = await storedFieldData(page); await checkpoint();
  phase = "offline-layouts"; await context.setOffline(true); page.once("dialog", dialog => { void dialog.accept(); }); await page.reload();
  for (const locale of ["en", "fr", "ar"] as const) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.locator("html").getAttribute("lang") !== locale) await page.getByTestId("field-language").getByTestId(`locale-switch-${locale}`).click();
    await expect(page).toHaveURL(url => url.pathname === `/${locale}/app/field/validate/${taskId}` || (url.pathname === `/${locale}/offline/field` && url.searchParams.get("view") === "supervised" && url.searchParams.get("task") === taskId));
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    page.once("dialog", dialog => { void dialog.accept(); }); await page.reload();
    await expect(reason).toHaveValue("Offline supervisor confirms the dedicated employee's work"); await expect(checkboxes.first()).toBeChecked();
    await expect(form.locator('[name="idempotencyKey"]')).toHaveValue(originalNonce); await expect(form.locator('[name="performedByPersonId"]')).toHaveValue(fixture.workerPersonId);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    checks.push({ locale, width }); await checkpoint();
  }
  expect(await storedFieldData(page)).toEqual(evidence.originalQueue); phase = "original-review-queued"; await checkpoint();
  await edits.goto(`/en/app/operations/${taskId}`); const reschedule = edits.getByTestId("operation-reschedule-form"); await expect(reschedule).toBeVisible();
  const date = new Date(`${await reschedule.locator('[name="dueDate"]').inputValue()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1);
  await reschedule.locator('[name="dueDate"]').fill(date.toISOString().slice(0, 10)); await reschedule.locator('[name="reason"]').fill("Staging verifies explicit review after the current job changes");
  evidence.rescheduleKey = await reschedule.locator('[name="idempotencyKey"]').inputValue(); evidence.rescheduleSubmitted = true; phase = "native-critical-change"; await checkpoint();
  await reschedule.locator('button[type="submit"]').click(); await expect(reschedule.getByRole("status")).toBeVisible();
  blockForUpgrade = false;
  phase = "conflict-review"; await context.setOffline(false); await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click(); await expect(page.getByTestId("field-proxy-review-required")).toBeVisible();
  await page.getByTestId("field-sync-now").click();
  await expect.poll(async () => (await cachedTask())[0]?.task.proxyValidation?.expectedVersion).toBeGreaterThan(Number(evidence.originalVersion));
  await expect(page.getByTestId("field-proxy-submit")).toBeDisabled(); await expect(form.locator('[name="idempotencyKey"]')).toHaveValue(originalNonce);
  expect(rows.parse(await storedFieldData(page))).toEqual([expect.objectContaining({ operation: expect.objectContaining({ client_op_id: originalNonce }), syncStatus: "conflict" })]);
  await page.getByTestId("field-proxy-review").click(); await expect(form.locator('[name="idempotencyKey"]')).not.toHaveValue(originalNonce);
  reviewingNonce = await form.locator('[name="idempotencyKey"]').inputValue(); expect(reviewingNonce).not.toBe(originalNonce);
  await expect(checkboxes.first()).not.toBeChecked(); await expect(page.getByTestId("field-proxy-submit")).toBeDisabled();
  evidence.reviewedNonce = reviewingNonce; evidence.reviewedVersion = Number(await form.locator('[name="expectedVersion"]').inputValue()); await checkpoint();
  holdSuccess = true; await context.setOffline(true); for (const checkbox of await checkboxes.all()) await checkbox.check();
  await reason.fill("Reconfirmed the current job and dedicated employee after explicit review");
  await page.getByTestId("field-proxy-submit").click(); await expect(page.getByTestId("field-proxy-queued")).toBeVisible();
  evidence.reviewedQueue = await storedFieldData(page); phase = "lost-applied-acknowledgement"; await checkpoint();
  await context.setOffline(false); await expect.poll(() => lost).toBe(true); evidence.lostAppliedAcknowledgement = true; await checkpoint();
  await context.setOffline(true); await page.reload(); expect(await storedFieldData(page)).toEqual(evidence.reviewedQueue);
  holdSuccess = false; sending = false; await context.setOffline(false);
  await expect(page).toHaveURL(url => /^\/(en|fr|ar)\/app\/field\/validate$/u.test(url.pathname) ||
    (/^\/(en|fr|ar)\/offline\/field$/u.test(url.pathname) && url.searchParams.get("view") === "supervised" && !url.searchParams.has("task")));
  await expect.poll(async () => rows.parse(await storedFieldData(page))).toEqual([expect.objectContaining({ operation: expect.objectContaining({ client_op_id: originalNonce }),
    syncStatus: "conflict", resolvedByClientOpId: reviewingNonce, result: expect.objectContaining({ status: "CONFLICT" }) })]);
  expect(wire.some(item => item.nonce === originalNonce && item.status === "CONFLICT")).toBe(true);
  expect(wire.some(item => item.nonce === reviewingNonce && item.status === "APPLIED")).toBe(true);
  expect(wire.some(item => item.nonce === reviewingNonce && item.status === "DUPLICATE")).toBe(true);
  expect(new Set(wire.filter(item => item.nonce === reviewingNonce).map(item => item.device)).size).toBe(1);
  expect(await storedFieldData(page, "proxyDrafts")).toEqual([]); expect(errors).toEqual([]);
  expect(await (await context.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  expect(gate.state().configuredWorkers).toBeGreaterThan(0);
  evidence.completed = true; evidence.authenticated = true; phase = "complete"; await checkpoint();
  console.log(JSON.stringify({ sha, offlineSupervisorLayouts: checks.length, explicitReview: true, originalConflictRetained: true, lostAcknowledgementRecovered: true, authenticated: true }));
} catch (error) {
  evidence.failure = { phase, name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message.split("\n")[0].replace(/https?:\/\/\S+/gu, "[url]") : "Unavailable" };
  await checkpoint(); console.error(JSON.stringify({ offlineSupervisorStaging: "incomplete", phase, originalProfileAndKeysRetained: true })); process.exitCode = 1;
} finally { await context.close(); gate.close(); await editor.close(); }
