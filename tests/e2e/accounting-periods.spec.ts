import { randomInt, randomUUID } from "node:crypto";
import { expect, test, type Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";
import { openFieldFixture } from "./support/field-fixture";

test.use({ timezoneId: "America/Denver", serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native monthly close and bounded reopening preserve journals and deny field access in ${locale}`, async ({ page: admin, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL required"); test.setTimeout(180000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Native period acceptance requires local PostgreSQL");
  const f = await openFieldFixture(admin, info, "en"), suffix = randomUUID().slice(0, 8), origin = new URL(admin.url()).origin;
  const context = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 900 } });
  const field = await context.newPage(), errors: string[] = [];
  admin.on("pageerror", error => errors.push(error.message)); field.on("pageerror", error => errors.push(error.message));
  const phone = `+21266${randomInt(1_000_000, 10_000_000)}`, pin = "368247", policyReason = `Dedicated period policy ${suffix}`;
  const headers = (request: Request) => ({ "content-type": request.headers()["content-type"], "next-action": request.headers()["next-action"], accept: "text/x-component", origin });
  const financialFacts = () => withTenant(f.db, f.organizationId, async tx => {
    const [row] = await tx.$queryRaw<Array<{ facts: unknown }>>`SELECT app_accounting_period_snapshot(${f.organizationId}::uuid,'-infinity'::timestamptz,'infinity'::timestamptz) AS facts`;
    return row.facts;
  });
  try {
    const month = await withTenant(f.db, f.organizationId, async tx => {
      const reference = await nextReferenceNumber(tx, f.organizationId, "PERIOD_QA"), slot = Number(reference.split("-").at(-1));
      const date = new Date(Date.UTC(1900, -slot, 1)), value = date.toISOString().slice(0, 7);
      const bounds = await new AccountingPeriodRepository(tx, f.organizationId).bounds(value, "Europe/Paris");
      expect(await tx.financialTransaction.count({ where: { occurredAt: { gte: bounds.startsAt, lt: bounds.endsAt } } })).toBe(0);
      return value;
    });
    const before = await financialFacts();
    await admin.goto(`/${locale}/app/configuration`);
    await admin.locator('input[name="scopeType"][value="organization"]').check();
    await admin.getByTestId("config-rule-key").selectOption("finance.accounting_periods");
    await expect(admin.getByTestId("config-rule-key")).toHaveValue("finance.accounting_periods");
    await admin.getByTestId("config-rule-lifecycle").selectOption("ACTIVE");
    await admin.getByTestId("config-rule-value").fill(JSON.stringify({ timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 60 }));
    await admin.getByTestId("config-rule-effective-from").fill("2000-01-01T00:00"); await admin.getByTestId("config-rule-reason").fill(policyReason);
    await expect(admin.getByTestId("config-rule-key")).toHaveValue("finance.accounting_periods");
    await admin.getByTestId("config-rule-submit").click();
    await expect.poll(() => withTenant(f.db, f.organizationId, tx => tx.configRule.count({ where: { key: "finance.accounting_periods", reason: policyReason, lifecycle: "ACTIVE" } }))).toBe(1);

    await admin.goto("/en/app/identity"); await admin.getByTestId("invite-display-name").fill(`Dedicated period field ${suffix}`);
    await admin.getByTestId("invite-phone").fill(phone); await admin.getByTestId("invite-role").selectOption("field_staff");
    await admin.getByTestId("invite-scope-type").selectOption("job"); await admin.getByTestId("invite-scope-id").fill(f.taskId);
    await admin.getByTestId("invite-preferred-locale").selectOption(locale); await admin.getByTestId("invite-submit").click();
    const invitation = (await admin.getByTestId("invitation-code").innerText()).split(":").at(-1)!.trim();
    await field.goto(`/${locale}/activate/${invitation}`); await field.getByTestId("activation-phone").fill(phone); await field.getByTestId("activation-pin").fill(pin);
    await field.getByTestId("activation-submit").click(); await expect(field).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await field.goto(`/${locale}/login?surface=field`); await field.getByTestId("login-phone").fill(phone); await field.getByTestId("login-pin").fill(pin);
    await field.getByTestId("login-submit").click(); await expect(field).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
    const fieldUser = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await field.request.get("/api/auth/session")).json()).user;

    await admin.goto(`/${locale}/app/finance/periods`); await expect(admin.getByTestId("accounting-periods-page")).toBeVisible();
    const close = admin.getByTestId("accounting-period-close"); await close.getByTestId("accounting-period-month").fill(month);
    await close.getByTestId("accounting-period-reason").fill(`Dedicated reconciled close ${suffix}`);
    await expect(close.getByTestId("accounting-period-month")).toHaveValue(month);
    const captureClose = admin.waitForRequest(request => request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes(month)));
    await close.getByRole("button").click(); const closing = await captureClose;
    await expect(admin.getByTestId("accounting-period-state")).toHaveAttribute("data-state", "CLOSED");
    const periodId = new URL(admin.url()).pathname.split("/").at(-1)!;
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => admin.request.post(closing.url(), { headers: headers(closing), data: closing.postDataBuffer()! })));
    for (const response of duplicates) expect(await response.text()).toContain('"ok":true');
    expect((await field.request.get(`/${locale}/app/finance/periods`)).status()).toBe(404);
    expect((await field.request.get(`/${locale}/app/finance/periods/${periodId}`)).status()).toBe(404);
    const deniedClose = await field.request.post(closing.url(), { headers: headers(closing), data: closing.postDataBuffer()! });
    expect(await deniedClose.text()).toContain('"code":"forbidden"');

    const reopen = admin.getByTestId("accounting-period-reopen"); await reopen.getByTestId("accounting-period-duration").fill("5");
    await reopen.getByTestId("accounting-period-reason").fill(`Dedicated short correction ${suffix}`);
    const captureReopen = admin.waitForRequest(request => request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes(periodId)));
    await reopen.getByRole("button").click(); const opening = await captureReopen;
    await expect(admin.getByTestId("accounting-period-state")).toHaveAttribute("data-state", "REOPENED");
    const originalWindow = await withTenant(f.db, f.organizationId, tx => tx.accountingPeriodEvent.findFirstOrThrow({ where: { periodId, kind: "REOPEN" } }));
    const openingReplies = await Promise.all(Array.from({ length: 4 }, () => admin.request.post(opening.url(), { headers: headers(opening), data: opening.postDataBuffer()! })));
    for (const response of openingReplies) expect(await response.text()).toContain('"ok":true');
    const deniedReopen = await field.request.post(opening.url(), { headers: headers(opening), data: opening.postDataBuffer()! });
    expect(await deniedReopen.text()).toContain('"code":"forbidden"');
    await expect(admin.getByTestId("accounting-period-state")).toHaveAttribute("data-state", "CLOSED", { timeout: 15000 });
    const late = await admin.request.post(opening.url(), { headers: headers(opening), data: opening.postDataBuffer()! }); expect(await late.text()).toContain('"ok":true');
    await admin.reload(); await expect(admin.getByTestId("accounting-period-state")).toHaveAttribute("data-state", "CLOSED");
    expect(await withTenant(f.db, f.organizationId, tx => tx.accountingPeriodEvent.count({ where: { periodId } }))).toBe(2);
    expect((await withTenant(f.db, f.organizationId, tx => tx.accountingPeriodEvent.findUniqueOrThrow({ where: { id: originalWindow.id } }))).reopensUntil).toEqual(originalWindow.reopensUntil);
    await expect(admin.getByTestId("accounting-period-history")).toHaveCount(2);
    await expect(admin.getByTestId("accounting-period-detail")).toBeVisible();
    await expect(admin.getByTestId("accounting-period-detail").getByRole("heading", { level: 1 })).toBeVisible();
    await expect(admin.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await admin.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await admin.screenshot({ path: info.outputPath(`accounting-period-${locale}.png`), fullPage: true });
    await admin.evaluate(() => { document.documentElement.style.fontSize = ""; });
    expect(await financialFacts()).toEqual(before);
    expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { resourceType: "accounting_period", resourceId: periodId } }))).toBe(2);
    expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { resourceType: "accounting_period", actorId: fieldUser.id } }))).toBe(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); await f.db.$disconnect(); }
});
