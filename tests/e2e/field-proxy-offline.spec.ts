import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";
import { fieldBrowser } from "./support/field-browser";
import { storedFieldData } from "./support/field-storage";
import { fieldWorkSnapshotSchema } from "@/modules/reservations/domain/field-pull";

const cached = z.array(z.object({ task: fieldWorkSnapshotSchema }));

test.use({ serviceWorkers: "allow", channel: "chromium" });
for (const locale of ["en", "fr", "ar"] as const) test(`Supervisor offline validation retains reviewed identity through cold reload and a lost acknowledgement in ${locale}`, async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for offline supervisor acceptance"); test.setTimeout(240000);
  expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page;
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined;
  try {
    const f = await openFieldFixture(page, info, locale, { checklistItems: 2 }); fixture = f;
    const original = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }));
    const performer = await withTenant(f.db, f.organizationId, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.organizationId, displayName: `Offline colleague ${randomUUID().slice(0, 8)}` } });
      await tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToPersonId: person.id, assignedToUserAccountId: null } }); return person;
    });
    await page.goto(`/${locale}/app/field/validate/${f.taskId}`);
    await expect.poll(async () => cached.parse(await storedFieldData(page, "proxyJobs")).filter(row => row.task.id === f.taskId)).toHaveLength(1);
    const form = page.getByTestId("field-proxy-form"), reason = form.locator('[name="reason"]'), checks = form.getByRole("checkbox");
    await reason.fill("Reviewed colleague work without a connection"); await checks.first().focus(); await page.keyboard.press("Space");
    const nonce = await form.locator('[name="idempotencyKey"]').inputValue();
    const version = await form.locator('[name="expectedVersion"]').inputValue();
    await expect.poll(async () => z.array(z.object({ clientOpId: z.string(), reason: z.string(), checklistItemIds: z.array(z.string()) })).parse(await storedFieldData(page, "proxyDrafts")))
      .toEqual([expect.objectContaining({ clientOpId: nonce, reason: "Reviewed colleague work without a connection", checklistItemIds: expect.any(Array) })]);
    await native.context.setOffline(true); page.once("dialog", dialog => { void dialog.accept(); }); await page.reload();
    await expect(page).toHaveURL(new RegExp(`/${locale}/offline/field\\?view=supervised&task=${f.taskId}$`, "u"));
    await expect(reason).toHaveValue("Reviewed colleague work without a connection"); await expect(checks.first()).toBeChecked(); await expect(checks.nth(1)).not.toBeChecked();
    await expect(form.locator('[name="idempotencyKey"]')).toHaveValue(nonce); await expect(form.locator('[name="expectedVersion"]')).toHaveValue(version);
    await expect(form.locator('[name="performedByPersonId"]')).toHaveValue(performer.id);
    await expect(page.getByTestId("field-proxy-identities")).toContainText(performer.displayName);
    await checks.nth(1).focus(); await page.keyboard.press("Space");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.getByTestId("field-proxy-submit").focus(); await page.keyboard.press("Enter");
    await expect(page.getByTestId("field-proxy-queued")).toBeVisible(); await expect(page.getByTestId("field-proxy-submit")).toBeDisabled();
    const queued = await storedFieldData(page); expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ operation: { client_op_id: nonce, type: "field_task.proxy_validate", payload: {
      taskId: f.taskId, performedByPersonId: performer.id, expectedVersion: Number(version), reason: "Reviewed colleague work without a connection" } } });
    await page.reload(); await expect(page.getByTestId("field-proxy-queued")).toBeVisible(); expect(await storedFieldData(page)).toEqual(queued);
    let lost = false, submitting = false;
    await native.context.route("**/api/sync/push", async route => {
      if (!submitting) {
        submitting = true;
        const response = await route.fetch(); expect(response.status()).toBe(200);
        expect(z.object({ results: z.array(z.object({ status: z.string() })) }).parse(await response.json()).results[0].status).toBe("APPLIED"); lost = true;
      }
      await route.abort();
    });
    await native.context.setOffline(false); await expect.poll(() => lost).toBe(true);
    expect(await storedFieldData(page)).toEqual(queued);
    await native.context.setOffline(true); await page.reload(); expect(await storedFieldData(page)).toEqual(queued);
    await native.context.unroute("**/api/sync/push"); await native.context.setOffline(false);
    await expect(page).toHaveURL(new RegExp(`/${locale}/app/field/validate$`, "u"));
    await expect.poll(() => storedFieldData(page)).toEqual([]);
    await expect.poll(async () => cached.parse(await storedFieldData(page, "proxyJobs")).filter(row => row.task.id === f.taskId)).toEqual([]);
    expect(await storedFieldData(page, "proxyDrafts")).toEqual([]);
    const proof = await withTenant(f.db, f.organizationId, async tx => ({ task: await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }),
      audit: await tx.auditLog.count({ where: { action: "task.proxy_validation.created", resourceId: f.taskId } }),
      events: await tx.outboxEvent.count({ where: { type: "ProxyValidated", payload: { path: ["taskId"], equals: f.taskId } } }),
      selfEvents: await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } }),
      sync: await tx.syncOp.count({ where: { clientOpId: nonce } }) }));
    expect(proof).toMatchObject({ audit: 1, events: 1, selfEvents: 0, sync: 1, task: { state: "COMPLETED", completionSource: "PROXY",
      completedByPersonId: performer.id, completedByUserAccountId: null, validatedByPersonId: original.assignedToPersonId, validatedByUserAccountId: original.assignedToUserAccountId } });
    expect(proof.task.validatedAt).not.toBeNull();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally { await native.context.setOffline(false); await fixture?.db.$disconnect(); await native.close(); }
});

test("Supervisor reviews a reassigned job with a new nonce while retaining the original conflict", async ({ browserName }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for conflict review"); test.setTimeout(240000); expect(browserName).toBe("chromium");
  const native = await fieldBrowser(info), page = native.page;
  let fixture: Awaited<ReturnType<typeof openFieldFixture>> | undefined;
  try {
    const f = await openFieldFixture(page, info, "fr"); fixture = f;
    const people = await withTenant(f.db, f.organizationId, async tx => {
      const first = await tx.person.create({ data: { organizationId: f.organizationId, displayName: "Initial reviewed colleague" } });
      const replacement = await tx.person.create({ data: { organizationId: f.organizationId, displayName: "Current reviewed colleague" } });
      await tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToPersonId: first.id, assignedToUserAccountId: null } }); return { first, replacement };
    });
    await page.goto(`/fr/app/field/validate/${f.taskId}`);
    await expect.poll(async () => cached.parse(await storedFieldData(page, "proxyJobs")).filter(row => row.task.id === f.taskId)).toHaveLength(1);
    const form = page.getByTestId("field-proxy-form"), reason = form.locator('[name="reason"]');
    await reason.fill("Initial review must not silently follow reassignment"); await form.getByRole("checkbox").check();
    const originalNonce = await form.locator('[name="idempotencyKey"]').inputValue();
    await native.context.setOffline(true); await page.getByTestId("field-proxy-submit").click(); await expect(page.getByTestId("field-proxy-queued")).toBeVisible();
    await withTenant(f.db, f.organizationId, tx => tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToPersonId: people.replacement.id, version: { increment: 1 } } }));
    await native.context.setOffline(false); await expect(page.getByTestId("field-proxy-review-required")).toBeVisible();
    await page.getByTestId("field-sync-now").click();
    await expect.poll(async () => cached.parse(await storedFieldData(page, "proxyJobs")).find(row => row.task.id === f.taskId)?.task.proxyValidation?.performedByPersonId).toBe(people.replacement.id);
    const failed = z.array(z.object({ operation: z.object({ client_op_id: z.string() }), syncStatus: z.string(), result: z.object({ status: z.string() }) })).parse(await storedFieldData(page));
    expect(failed).toEqual([expect.objectContaining({ operation: expect.objectContaining({ client_op_id: originalNonce }), syncStatus: "conflict", result: expect.objectContaining({ status: "CONFLICT" }) })]);
    await expect(page.getByTestId("field-proxy-submit")).toBeDisabled();
    await expect(form.locator('[name="performedByPersonId"]')).toHaveValue(people.first.id);
    await page.getByTestId("field-proxy-review").focus(); await page.keyboard.press("Enter");
    await expect(form.locator('[name="idempotencyKey"]')).not.toHaveValue(originalNonce);
    const reviewedNonce = await form.locator('[name="idempotencyKey"]').inputValue(); expect(reviewedNonce).not.toBe(originalNonce);
    await expect(form.locator('[name="performedByPersonId"]')).toHaveValue(people.replacement.id); await expect(form.getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByTestId("field-proxy-submit")).toBeDisabled();
    await reason.fill("Reconfirmed current colleague and reviewed checklist"); await form.getByRole("checkbox").check(); await page.getByTestId("field-proxy-submit").click();
    await expect(page).toHaveURL(/\/fr\/app\/field\/validate$/u);
    await expect.poll(async () => z.array(z.object({ operation: z.object({ client_op_id: z.string() }), syncStatus: z.string(), resolvedByClientOpId: z.string().optional(), result: z.object({ status: z.string() }) })).parse(await storedFieldData(page)))
      .toEqual([expect.objectContaining({ operation: expect.objectContaining({ client_op_id: originalNonce }), syncStatus: "conflict", resolvedByClientOpId: reviewedNonce, result: expect.objectContaining({ status: "CONFLICT" }) })]);
    const proof = await withTenant(f.db, f.organizationId, async tx => ({ task: await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }),
      audit: await tx.auditLog.count({ where: { action: "task.proxy_validation.created", resourceId: f.taskId } }),
      sync: await tx.syncOp.findMany({ where: { clientOpId: { in: [originalNonce, reviewedNonce] } }, select: { clientOpId: true, status: true } }) }));
    expect(proof.task.completedByPersonId).toBe(people.replacement.id); expect(proof.audit).toBe(1);
    expect(proof.sync).toEqual(expect.arrayContaining([{ clientOpId: originalNonce, status: "CONFLICT" }, { clientOpId: reviewedNonce, status: "APPLIED" }]));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally { await native.context.setOffline(false); await fixture?.db.$disconnect(); await native.close(); }
});
