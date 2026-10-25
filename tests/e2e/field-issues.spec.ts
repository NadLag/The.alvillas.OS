import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData, storedFieldPhotoDigests } from "./support/field-storage";

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
const rows = z.array(z.object({ deviceId: z.string(), operation: z.object({ client_op_id: z.uuid(), type: z.string(), payload: z.record(z.string(), z.unknown()) }) }));
for (const locale of ["en", "fr", "ar"] as const) test(`Phone + PIN worker reports an offline issue with one linked photo and safe replay in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required"); test.setTimeout(360000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Issue fixtures require isolated local PostgreSQL");
  const f = await openFieldFixture(page, info, "en"), roleKey = `e2e_issue_${randomUUID().replaceAll("-", "")}`;
  const phone = `+21265${randomInt(1_000_000, 10_000_000)}`, pin = "741852";
  let allowParts = false, allowAcknowledgements = false, issueApplied = false;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("/en/app/identity");
    const role = page.getByTestId("custom-role-create-form");
    await role.getByTestId("custom-role-name").fill(`Local issue reporter ${roleKey.slice(-6)}`);
    await role.getByTestId("custom-role-key").fill(roleKey); await role.getByTestId("custom-role-description").fill("Assigned-job maintenance observations, without financial access");
    for (const permission of ["task:view", "task:edit", "issue:create"]) await role.locator(`input[name="permissionKeys"][value="${permission}"]`).check();
    await role.getByTestId("custom-role-submit").click(); await expect(role.getByRole("status")).toHaveText("Custom role created.");
    await page.getByTestId("invite-display-name").fill(`Local issue employee ${locale}`); await page.getByTestId("invite-phone").fill(phone);
    await page.getByTestId("invite-role").selectOption(roleKey); await page.getByTestId("invite-scope-type").selectOption("job");
    await page.getByTestId("invite-scope-id").fill(f.taskId); await page.getByTestId("invite-preferred-locale").selectOption(locale);
    await page.getByTestId("invite-submit").click();
    const code = (await page.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim(); expect(code).toBeTruthy();
    await page.goto("/en/app"); await page.getByTestId("logout-button").click(); await expect(page).toHaveURL(/\/en\/login$/u);
    await page.goto(`/${locale}/activate/${code}`); await page.getByTestId("activation-phone").fill(phone); await page.getByTestId("activation-pin").fill(pin);
    await page.getByTestId("activation-submit").click(); await expect(page).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await page.goto(`/${locale}/login?surface=field`); await page.getByTestId("login-phone").fill(phone); await page.getByTestId("login-pin").fill(pin);
    await page.getByTestId("login-submit").click(); await expect(page).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
    const user = z.object({ user: z.object({ id: z.uuid(), personId: z.uuid(), organizationId: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json()).user;
    expect(user.organizationId).toBe(f.organizationId);
    await withTenant(f.db, f.organizationId, async tx => {
      const account = await tx.userAccount.findUniqueOrThrow({ where: { id: user.id }, include: { authCredentials: true } });
      expect(account.passwordHash).toBeNull(); expect(account.authCredentials.find(row => row.type === "PIN")?.secretHash).toMatch(/^\$argon2id\$/u);
      await tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToUserAccountId: user.id, assignedToPersonId: user.personId } });
    });
    expect((await page.request.get(`/${locale}/app/field/${randomUUID()}`)).status()).toBe(404);
    await page.goto(`/${locale}/app/field/${f.taskId}`); await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    const capture = page.getByTestId("field-issue"); await expect(capture.getByTestId("field-issue-title")).toBeEnabled();
    await page.context().route("**/api/field/uploads/part?**", route => allowParts ? route.continue() : route.abort());
    await page.context().route("**/api/sync/push", async route => {
      const batch = syncPushInputSchema.parse(route.request().postDataJSON());
      if (batch.ops[0].type !== "field_task.issue.report" || allowAcknowledgements) { await route.fulfill({ response: await route.fetch() }); return; }
      if (!issueApplied) { const response = await route.fetch(); expect(response.status()).toBe(200); issueApplied = true; }
      await route.abort();
    });
    const image = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
      const context = canvas.getContext("2d")!; context.fillStyle = "#0B6B5F"; context.fillRect(0, 0, 64, 64); return canvas.toDataURL("image/png").split(",")[1]; });
    const title = `Leaking tap ${locale}`, description = `Water leaking under the kitchen sink ${locale}`;
    await capture.getByTestId("field-issue-title").fill(title); await capture.getByTestId("field-issue-description").fill(description);
    await capture.getByTestId("field-issue-severity").selectOption("HIGH");
    await capture.getByTestId("field-issue-file").setInputFiles({ name: "sink.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await page.getByTestId("field-checklist-item").check(); await page.getByTestId("field-task-complete").click();
    await expect(page.getByTestId("field-issue-completion-blocked")).toBeVisible();
    await page.getByTestId("field-language").getByTestId(`locale-switch-${locale === "en" ? "fr" : "en"}`).click();
    await expect(page).toHaveURL(new RegExp(`/${locale}/app/field/${f.taskId}$`, "u"));
    await expect(page.getByTestId("field-language-notice")).toBeVisible();
    await expect.poll(() => page.evaluate(async () => (await Promise.all(["en", "fr", "ar"].map(language => caches.match(`/${language}/offline/field`)))).every(Boolean))).toBe(true);
    await page.context().setOffline(true); await capture.getByTestId("field-issue-save").click();
    await expect(capture.getByTestId("field-issue-queued")).toContainText(title);
    const original = rows.parse(await storedFieldData(page)); expect(original.map(row => row.operation.type)).toEqual(["field_photo.prepare", "field_task.issue.report"]);
    const issue = original[1]; expect(issue.operation.payload.photoClientOpId).toBe(original[0].operation.client_op_id);
    const digests = await storedFieldPhotoDigests(page); expect(digests).toHaveLength(1); expect(digests[0].actual).toBe(digests[0].expected);
    await page.reload(); await expect(capture.getByTestId("field-issue-queued")).toContainText(description);
    expect(rows.parse(await storedFieldData(page))).toEqual(original); expect(await storedFieldPhotoDigests(page)).toEqual(digests);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    for (const button of await capture.getByRole("button").all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(64);
    await page.screenshot({ path: info.outputPath(`field-issue-offline-${locale}.png`), fullPage: true });
    await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => storedFieldData(page, "photos")).toHaveLength(1);
    expect(await withTenant(f.db, f.organizationId, tx => tx.operationIssue.count({ where: { taskId: f.taskId } }))).toBe(0);
    allowParts = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.operationIssue.count({ where: { taskId: f.taskId } })), { timeout: 90000 }).toBe(1);
    const pending = rows.parse(await storedFieldData(page)); expect(pending).toEqual([issue]);
    const batch = { organization_id: f.organizationId, actor_user_id: user.id, device_id: issue.deviceId, op_schema_version: 1, ops: [issue.operation] };
    const origin = new URL(page.url()).origin;
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => page.request.post("/api/sync/push", { data: batch, headers: { Origin: origin } })));
    for (const response of duplicates) { expect(response.status()).toBe(200); expect(z.object({ results: z.array(z.object({ status: z.string() })) }).parse(await response.json()).results[0].status).toBe("DUPLICATE"); }
    allowAcknowledgements = true; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => storedFieldData(page), { timeout: 60000 }).toEqual([]); expect(await storedFieldData(page, "photos")).toEqual([]);
    const linked = await withTenant(f.db, f.organizationId, async tx => {
      const issues = await tx.operationIssue.findMany({ where: { taskId: f.taskId }, include: { evidence: true } }); expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ title, description, severity: "HIGH", createdBy: user.id }); expect(issues[0].evidence?.sha256).toBe(digests[0].expected);
      expect(await tx.auditLog.count({ where: { resourceId: f.taskId, action: "task.issue.reported" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "IssueReported", idempotencyKey: `issue:${issues[0].id}:reported` } })).toBe(1);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).state).toBe("ASSIGNED"); return issues[0];
    });
    await page.goto(`/${locale}/app/field/${f.taskId}`); await expect(page.getByTestId("task-evidence-panel")).toContainText(title);
    const photo = await page.request.get(`/api/operations/evidence/${linked.evidenceId}`); expect(photo.status()).toBe(200); expect(photo.headers()["content-type"]).toContain("image/jpeg");
    await capture.getByTestId("field-issue-title").fill(`No photo ${locale}`); await capture.getByTestId("field-issue-description").fill("Observation without a photograph");
    await capture.getByTestId("field-issue-save").click();
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.operationIssue.count({ where: { taskId: f.taskId } }))).toBe(2);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(errors).toEqual([]);
  } finally { await page.context().unrouteAll({ behavior: "wait" }); await f.db.$disconnect(); }
});
