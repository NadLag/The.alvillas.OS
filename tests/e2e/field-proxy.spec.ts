import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";

for (const locale of ["en", "fr", "ar"]) test(`Field supervisor validates person-only work with a stale-version guard in ${locale}`, async ({ page, context }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for supervisor validation"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Supervisor fixtures require local PostgreSQL");
  const f = await openFieldFixture(page, info, locale, { checklistItems: 2 });
  try {
    const original = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }));
    const path = `/${locale}/app/field/validate/${f.taskId}`;
    expect((await page.request.get(path)).status()).toBe(404);
    const worker = await withTenant(f.db, f.organizationId, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.organizationId, displayName: `Local colleague ${randomUUID().slice(0, 8)}` } });
      await tx.operationTask.update({ where: { id: f.taskId }, data: { assignedToPersonId: person.id, assignedToUserAccountId: null } }); return person;
    });
    const task = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId }, include: { property: true } }));
    await page.goto(`/${locale}/app/field`); await page.getByTestId("field-proxy-entry").click();
    await page.getByTestId("field-proxy-search").fill(task.property.name); await page.getByTestId("field-proxy-search").press("Enter");
    await expect(page.getByTestId("field-proxy-card")).toHaveCount(1); await page.getByTestId("field-proxy-card").click();
    await expect(page.getByTestId("field-proxy-identities")).toContainText(worker.displayName);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const form = page.getByTestId("field-proxy-form"), submit = page.getByTestId("field-proxy-submit");
    await expect(submit).toBeDisabled(); await form.locator('[name="reason"]').fill("Worker has no internet connection");
    for (const input of await form.getByRole("checkbox").all()) await input.check(); await expect(submit).toBeEnabled();
    await page.getByTestId("field-language").locator('a:not([aria-current="page"])').first().click();
    await expect(page.getByTestId("field-language-notice")).toBeVisible(); await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    await page.locator(".shell-header a").click(); await expect(page.getByTestId("field-proxy-unsaved")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    await context.setOffline(true); await expect(submit).toBeDisabled(); await expect(page.getByTestId("field-proxy-offline")).toBeVisible();
    await expect(form.locator('[name="reason"]')).toHaveValue("Worker has no internet connection"); await context.setOffline(false); await expect(submit).toBeEnabled();
    await page.getByTestId("field-proxy-evidence").locator("summary").click();
    const evidence = page.getByTestId("operation-evidence-form"); await evidence.locator('[name="reason"]').fill("Optional supervisor evidence");
    await evidence.locator('button[type="submit"]').click(); await expect(page.getByTestId("field-proxy-evidence")).toContainText("Optional supervisor evidence");
    await expect(form.locator('[name="reason"]')).toHaveValue(""); await expect(form.getByRole("checkbox").first()).not.toBeChecked();
    await form.locator('[name="reason"]').fill("Worker has no internet connection"); for (const input of await form.getByRole("checkbox").all()) await input.check();
    const second = await context.newPage(); await second.goto(`/${locale}/app/operations/${task.id}`);
    const transition = second.getByTestId("operation-transition-form"); await transition.locator('[name="state"]').selectOption("BLOCKED");
    await transition.locator('[name="reason"]').fill("A second client changed this job"); await transition.locator('button[type="submit"]').click();
    await expect(transition.getByRole("status")).toBeVisible();
    await submit.click(); await expect(page.getByTestId("field-proxy-error")).toBeVisible();
    await expect(form.locator('[name="reason"]')).toHaveValue("Worker has no internet connection");
    const blocked = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: task.id } }));
    expect(blocked.state).toBe("BLOCKED"); expect(blocked.validatedAt).toBeNull();
    await transition.locator('[name="state"]').selectOption("PLANNED"); await transition.locator('[name="reason"]').fill("Reopen the local acceptance job");
    await transition.locator('button[type="submit"]').click();
    await expect.poll(async () => (await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: task.id } }))).state).toBe("PLANNED");
    await withTenant(f.db, f.organizationId, tx => tx.operationTask.update({ where: { id: task.id }, data: { state: "ASSIGNED" } }));
    await second.close();
    page.once("dialog", dialog => { void dialog.accept(); }); await page.reload();
    await expect(form.getByRole("checkbox").first()).not.toBeChecked(); await form.locator('[name="reason"]').fill("Reconfirmed work performed by colleague");
    for (const input of await form.getByRole("checkbox").all()) await input.check();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`field-proxy-${locale}.png`), fullPage: true });
    await submit.focus(); await page.keyboard.press("Enter"); await expect(page.getByTestId("field-proxy-completed")).toBeVisible();
    const proof = await withTenant(f.db, f.organizationId, async tx => ({ task: await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } }),
      audits: await tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } }),
      evidence: await tx.operationTaskEvidence.count({ where: { taskId: task.id, note: "Optional supervisor evidence" } }),
      events: await tx.outboxEvent.count({ where: { type: "ProxyValidated", payload: { path: ["taskId"], equals: task.id } } }) }));
    expect(proof.task).toMatchObject({ state: "COMPLETED", completionSource: "PROXY", completedByPersonId: worker.id,
      completedByUserAccountId: null, validatedByPersonId: original.assignedToPersonId, validatedByUserAccountId: original.assignedToUserAccountId,
      validationReason: "Reconfirmed work performed by colleague" }); expect(proof.task.validatedAt).not.toBeNull(); expect(proof.audits).toBe(1); expect(proof.events).toBe(1); expect(proof.evidence).toBe(1);
    await page.reload(); await expect(page.getByTestId("field-proxy-completed")).toBeVisible(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally { await context.setOffline(false); await f.db.$disconnect(); }
});
