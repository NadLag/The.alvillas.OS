import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { chromium, expect as playwrightExpect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { fieldDevicePolicyKey, fieldDevicePolicySnapshotSchema } from "../src/platform/config/field-device-policy";
import { fieldWorkSnapshotSchema } from "../src/modules/reservations/domain/field-pull";
import { syncPushInputSchema, syncPushOpSchema } from "../src/modules/reservations/domain/sync-protocol";
import { storedFieldData } from "../tests/e2e/support/field-storage";

const expect = playwrightExpect.configure({ timeout: 30000 }), origin = "https://the-alvillas-os-staging.vercel.app";
const sha = z.string().regex(/^[a-f0-9]{40}$/u).parse(process.env.STAGING_EXPECTED_SHA);
const state = z.string().min(1).parse(process.env.STAGING_STORAGE_STATE_FILE);
const administratorState = z.string().min(1).parse(process.env.STAGING_ADMIN_STORAGE_STATE_FILE);
const file = z.string().min(1).parse(process.env.STAGING_EVIDENCE_FILE), profile = z.string().min(1).parse(process.env.STAGING_PROFILE_DIRECTORY);
const fixtureFile = z.string().min(1).parse(process.env.STAGING_OPERATIONS_FIXTURE_FILE);
const fixture = z.object({ origin: z.literal(origin), completed: z.literal(true), accountKind: z.literal("dedicated-field-device-policy"),
  organizationId: z.uuid(), actorId: z.uuid(), actorPersonId: z.uuid(), administratorId: z.uuid(), propertyId: z.uuid(),
  propertyName: z.string().regex(/^Automation acceptance aut-[a-f0-9]{8}$/u),
  tasks: z.array(z.object({ id: z.uuid(), assigned: z.literal(true) })).length(2) }).parse(JSON.parse(await readFile(fixtureFile, "utf8")));
const taskId = fixture.tasks[0].id, otherId = fixture.tasks[1].id, privateParent = await realpath(dirname(state));
const previous = z.object({ configureSubmitted: z.boolean().optional(), queued: z.boolean().optional(), completed: z.boolean().optional() })
  .parse(JSON.parse(await readFile(file, "utf8")));
if (previous.configureSubmitted || previous.queued || previous.completed) throw new Error("Preserve the private warning checkpoint and original operation; recover read-only before replay");
if (taskId === otherId || fixture.actorId === fixture.administratorId || basename(profile) !== "staging-field-device-policy-native" ||
  dirname(await realpath(profile)) !== privateParent || (await Promise.all([file, administratorState, fixtureFile].map(path => realpath(path)))).some(path => dirname(path) !== privateParent))
  throw new Error("Verified private dedicated fixture, profile and independent administrator required");
const saved = z.object({ cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string(), path: z.string(), expires: z.number(),
  httpOnly: z.boolean(), secure: z.boolean(), sameSite: z.enum(["Strict", "Lax", "None"]) })) }).parse(JSON.parse(await readFile(state, "utf8")));
const context = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium", baseURL: origin,
  ignoreDefaultArgs: ["--disable-background-networking"], viewport: { width: 1440, height: 1000 }, timezoneId: "America/Denver" });
const browser = await chromium.launch(), owner = await browser.newContext({ baseURL: origin, storageState: administratorState });
for (const current of [context, owner]) { current.setDefaultTimeout(30000); current.setDefaultNavigationTimeout(90000); }
const page = await context.newPage(), editor = await owner.newPage(), checks: Array<{ locale: string; width: number }> = [];
const wire: Array<{ deviceId: string; clientOpId: string; status: string }> = [], errors: string[] = [];
const evidence: Record<string, unknown> = { sha, ...fixture, taskId, otherId, checks, wire, completed: false };
let phase = "authentication", blocked = true, loseApplied = true, originalNonce = "", originalDevice = "";
const checkpoint = () => writeFile(file, JSON.stringify({ ...evidence, phase }, null, 2));
page.on("pageerror", error => errors.push(error.message));
try {
  await context.addCookies(saved.cookies.filter(cookie => cookie.domain.replace(/^\./u, "") === new URL(origin).hostname));
  await page.clock.install();
  expect(await (await owner.request.get("/api/version")).json()).toMatchObject({ version: sha, environment: "preview", commitRef: "main" });
  for (const [current, expectedId] of [[context, fixture.actorId], [owner, fixture.administratorId]] as const) {
    const user = z.object({ user: z.object({ id: z.uuid(), organizationId: z.uuid(), personId: z.uuid(),
      securitySetupRequired: z.boolean().optional(), sessionRevoked: z.boolean().optional() }) }).parse(await (await current.request.get("/api/auth/session")).json()).user;
    expect(user.id).toBe(expectedId); expect(user.organizationId).toBe(fixture.organizationId);
    expect(user.securitySetupRequired).not.toBe(true); expect(user.sessionRevoked).not.toBe(true);
    if (current === context) expect(user.personId).toBe(fixture.actorPersonId);
  }
  await context.route("**/api/sync/push", async route => {
    if (blocked) { await route.abort(); return; }
    try {
      const input = syncPushInputSchema.parse(route.request().postDataJSON());
      expect(input.organization_id).toBe(fixture.organizationId); expect(input.actor_user_id).toBe(fixture.actorId);
      expect(input.device_id).toBe(originalDevice); expect(input.ops).toHaveLength(1); expect(input.ops[0].client_op_id).toBe(originalNonce);
      const response = await route.fetch(), result = z.object({ results: z.array(z.object({ client_op_id: z.uuid(), status: z.string() })).length(1) }).parse(await response.json());
      wire.push({ deviceId: input.device_id, clientOpId: result.results[0].client_op_id, status: result.results[0].status });
      if (loseApplied && result.results[0].status === "APPLIED") { loseApplied = false; await checkpoint(); await route.abort(); }
      else await route.fulfill({ response });
    } catch { errors.push("device_policy_sync_transport_unavailable"); await route.abort().catch(() => undefined); }
  });
  const configure = async (minutes: number | null) => {
    phase = minutes === null ? "disable-warning" : "configure-warning";
    await editor.goto("/en/app/configuration"); const form = editor.getByTestId("config-rule-create-form");
    await form.locator('[name="scopeType"][value="property"]').check(); await form.getByTestId("config-rule-scope-id").selectOption(fixture.propertyId);
    await form.getByTestId("config-rule-key").selectOption(fieldDevicePolicyKey); await expect(form.getByTestId("config-rule-key")).toHaveValue(fieldDevicePolicyKey);
    await form.getByTestId("config-rule-lifecycle").selectOption("ACTIVE");
    await form.getByTestId("config-rule-value").fill(JSON.stringify({ queueWarningAfterMinutes: minutes }));
    await form.getByTestId("config-rule-effective-from").fill("2020-01-01T00:00");
    await form.getByTestId("config-rule-reason").fill("Dedicated staging acceptance of the advisory field queue warning");
    expect(await form.evaluate(element => Object.fromEntries(new FormData(element as HTMLFormElement).entries())))
      .toMatchObject({ key: fieldDevicePolicyKey, scopeType: "property", scopeId: fixture.propertyId, lifecycle: "ACTIVE", valueJson: JSON.stringify({ queueWarningAfterMinutes: minutes }) });
    evidence.configureSubmitted = true; await checkpoint(); await form.getByTestId("config-rule-submit").click();
    await expect(form.getByTestId("config-rule-form-message")).toHaveAttribute("role", "status");
    evidence[minutes === null ? "disabledConfigurationSubmitted" : "enabledConfigurationSubmitted"] = true; await checkpoint();
  };
  await configure(1);
  await page.goto(`/en/app/field/${taskId}`); await expect(page.getByTestId("field-task-page")).toContainText(fixture.propertyName);
  const cachedTasks = async () => z.array(z.object({ task: fieldWorkSnapshotSchema })).parse(await storedFieldData(page, "jobs")).map(row => row.task);
  await expect.poll(async () => (await cachedTasks()).filter(task => [taskId, otherId].includes(task.id)).length).toBe(2);
  const policy = async () => (await cachedTasks()).find(task => task.id === taskId)?.devicePolicy;
  await expect.poll(async () => (await policy())?.queueWarningAfterMinutes).toBe(1);
  evidence.enabledPolicy = fieldDevicePolicySnapshotSchema.parse(await policy()); await checkpoint();
  await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(locale => caches.match(`/${locale}/offline/field`)))).every(Boolean))).toBe(true);
  await page.clock.fastForward(120000); await context.setOffline(true);
  phase = "queue-original-operation"; evidence.queued = true; await checkpoint();
  await expect(page.getByTestId("field-checklist-item").first()).toBeVisible();
  for (const checkbox of await page.getByTestId("field-checklist-item").all()) await checkbox.check();
  await page.getByTestId("field-task-complete").click();
  await expect.poll(() => storedFieldData(page)).toHaveLength(1); const original = await storedFieldData(page);
  const record = z.array(z.object({ deviceId: z.uuid(), operation: syncPushOpSchema, devicePolicy: fieldDevicePolicySnapshotSchema })).length(1).parse(original)[0];
  expect(record.operation.type).toBe("field_task.complete"); expect(record.operation.payload.taskId).toBe(taskId);
  expect(Date.parse(record.operation.client_created_at!)).toBeGreaterThan(Date.now());
  originalNonce = record.operation.client_op_id; originalDevice = record.deviceId;
  evidence.originalQueue = original; evidence.originalNonce = originalNonce; evidence.originalDeviceId = originalDevice; evidence.futureClientTimestamp = true; await checkpoint();
  await expect(page.getByTestId("field-queue-age-warning")).toHaveCount(0); await page.clock.fastForward(60001);
  await expect(page.getByTestId("field-queue-age-warning")).toBeVisible();
  phase = "offline-warning-layouts";
  for (const locale of ["en", "fr", "ar"] as const) for (const width of [1440, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    if (await page.locator("html").getAttribute("lang") !== locale) await page.getByTestId("field-language").getByTestId(`locale-switch-${locale}`).click();
    await page.reload(); await expect(page.getByTestId("field-queue-age-warning")).toBeVisible();
    expect(await storedFieldData(page)).toEqual(original); await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    checks.push({ locale, width }); await checkpoint();
  }
  await page.goto(`/en/app/field/${otherId}`); await expect(page.getByTestId("field-checklist-item").first()).toBeVisible();
  for (const checkbox of await page.getByTestId("field-checklist-item").all()) await checkbox.check();
  await expect(page.getByTestId("field-task-complete")).toBeEnabled(); await expect(page.getByTestId("field-queue-age-warning")).toBeVisible();
  evidence.otherWorkRemainsAvailable = true; await checkpoint();
  await context.setOffline(false); await configure(null); await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
  await expect.poll(async () => (await policy())?.queueWarningAfterMinutes).toBeNull();
  evidence.disabledPolicy = fieldDevicePolicySnapshotSchema.parse(await policy());
  await expect(page.getByTestId("field-queue-age-warning")).toHaveCount(0);
  for (const checkbox of await page.getByTestId("field-checklist-item").all()) await expect(checkbox).toBeChecked();
  expect(await storedFieldData(page)).toEqual(original); evidence.originalDraftAndQueueRetainedAfterDisable = true; await checkpoint();
  phase = "original-key-lost-acknowledgement"; blocked = false;
  await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
  await expect.poll(() => wire.some(item => item.status === "APPLIED")).toBe(true); expect(await storedFieldData(page)).toEqual(original);
  await expect(page.getByTestId("field-sync-now")).toBeEnabled(); await page.getByTestId("field-sync-now").click();
  await expect.poll(() => storedFieldData(page)).toEqual([]); expect(wire.some(item => item.status === "DUPLICATE")).toBe(true);
  for (const checkbox of await page.getByTestId("field-checklist-item").all()) await expect(checkbox).toBeChecked(); expect(errors).toEqual([]);
  expect(wire.filter(item => item.status === "APPLIED")).toHaveLength(1); expect(wire.every(item => item.clientOpId === originalNonce && item.deviceId === originalDevice)).toBe(true);
  evidence.completed = true; evidence.originalKeyAndDeviceRetained = true; phase = "complete"; await checkpoint();
  console.log(JSON.stringify({ configuredFieldWarning: "browser-verified", nativeLayouts: checks.length, originalKeyRetained: true, nativePinEmployee: true, readOnlyDataProofPending: true }));
} catch {
  await checkpoint(); console.error(JSON.stringify({ configuredFieldWarning: "incomplete", phase, checkpointRetained: true })); process.exitCode = 1;
} finally { await context.close(); await browser.close(); }
