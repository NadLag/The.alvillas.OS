import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Request } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { openFieldFixture } from "./support/field-fixture";

test.use({ actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native payment accounts fund expenses and deny field access in ${locale}`, async ({ page: admin, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Account acceptance requires local PostgreSQL");
  const f = await openFieldFixture(admin, info, "en"), origin = new URL(admin.url()).origin, suffix = randomUUID().slice(0, 8);
  const fieldContext = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 800 } });
  const field = await fieldContext.newPage(), prefix = `Dedicated funding ${suffix}`, errors: string[] = [];
  admin.on("pageerror", error => errors.push(error.message));
  const phone = `+21266${randomInt(1_000_000, 10_000_000)}`, pin = "368247";
  try {
    const setup = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: f.taskId } } });
      await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
      return { propertyId: task.propertyId, journals: await tx.financialTransaction.count() };
    });
    await admin.goto("/en/app/identity");
    await admin.getByTestId("invite-display-name").fill(`Dedicated account-denial employee ${suffix}`);
    await admin.getByTestId("invite-phone").fill(phone); await admin.getByTestId("invite-role").selectOption("field_staff");
    await admin.getByTestId("invite-scope-type").selectOption("job"); await admin.getByTestId("invite-scope-id").fill(f.taskId);
    await admin.getByTestId("invite-preferred-locale").selectOption(locale); await admin.getByTestId("invite-submit").click();
    const invitation = (await admin.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim(); expect(invitation).toBeTruthy();
    await field.goto(`/${locale}/activate/${invitation}`); await field.getByTestId("activation-phone").fill(phone); await field.getByTestId("activation-pin").fill(pin);
    await field.getByTestId("activation-submit").click(); await expect(field).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await field.goto(`/${locale}/login?surface=field`); await field.getByTestId("login-phone").fill(phone); await field.getByTestId("login-pin").fill(pin);
    await field.getByTestId("login-submit").click(); await expect(field).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
    const fieldUser = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await field.request.get("/api/auth/session")).json()).user;

    await admin.goto(`/${locale}/app/properties/${setup.propertyId}/expenses/new`);
    await admin.getByTestId("expense-manage-accounts").click();
    await expect(admin.getByTestId("financial-accounts-page")).toBeVisible();
    await admin.getByTestId("payment-account-search").fill(prefix);
    await admin.getByTestId("payment-account-search-form").locator('button[type="submit"]').click();
    let captured: Request | undefined;
    for (const kind of ["BANK", "CASH", "OTHER"]) {
      const name = `${prefix} ${kind}`;
      await admin.getByTestId("payment-account-name").fill(name);
      await admin.getByTestId("payment-account-kind").selectOption(kind);
      await admin.getByTestId("payment-account-reason").fill("Dedicated native payment account acceptance");
      const capture = kind === "BANK" ? admin.waitForRequest(request => request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes(name))) : null;
      await admin.getByTestId("payment-account-create").click();
      if (capture) captured = await capture;
      await expect(admin.getByTestId("payment-account-row").filter({ hasText: name })).toBeVisible();
      await expect(admin.getByTestId("payment-account-saved")).toBeVisible();
    }
    if (!captured) throw Error("Native account action was not captured");
    const request = captured;
    const action = { data: request.postDataBuffer()!, headers: { "content-type": request.headers()["content-type"], "next-action": request.headers()["next-action"], accept: "text/x-component", origin } };
    const retries = await Promise.all(Array.from({ length: 4 }, () => admin.request.post(request.url(), action)));
    for (const response of retries) expect(await response.text()).toContain('"ok":true');
    const denied = await field.request.get(`/${locale}/app/finance/accounts`);
    expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(prefix);
    const deniedAction = await field.request.post(request.url(), action);
    expect(await deniedAction.text()).toContain('"code":"forbidden"');
    const bank = await withTenant(f.db, f.organizationId, async tx => {
      const accounts = await tx.ledgerAccount.findMany({ where: { organizationId: f.organizationId, name: { startsWith: prefix } } });
      expect(accounts).toHaveLength(3);
      for (const account of accounts) {
        expect(account).toMatchObject({ accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
        expect(await tx.auditLog.count({ where: { organizationId: f.organizationId, resourceId: account.id, action: "finance.account.created" } })).toBe(1);
        expect(await tx.auditLog.count({ where: { organizationId: f.organizationId, resourceId: account.id, actorId: fieldUser.id } })).toBe(0);
      }
      expect(await tx.financialTransaction.count()).toBe(setup.journals);
      return accounts.find(account => account.name === `${prefix} BANK`)!;
    });
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await expect(admin.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await admin.locator("main").evaluate(element => { (element as HTMLElement).style.fontSize = "200%"; });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await admin.screenshot({ path: info.outputPath(`payment-accounts-${locale}.png`), fullPage: true });

    await admin.getByTestId("payment-account-row").filter({ hasText: `${prefix} BANK` }).getByTestId("payment-account-use").click();
    await expect(admin.getByTestId("expense-funding-account")).toHaveValue(bank.id);
    await admin.getByTestId("expense-amount").fill("100,01"); await admin.getByTestId("expense-category").fill("maintenance");
    await admin.getByTestId("expense-purpose").fill(`${prefix} native funded expense`);
    await admin.getByTestId("expense-occurred-on").fill("2026-10-26"); await admin.getByTestId("expense-reason").fill("Dedicated native account expense funding");
    await admin.getByTestId("expense-create").click(); await expect(admin.getByTestId("expense-detail-page")).toBeVisible();
    const expenseId = new URL(admin.url()).pathname.split("/").at(-1)!;
    await withTenant(f.db, f.organizationId, async tx => {
      const expense = await tx.expense.findUniqueOrThrow({ where: { organizationId_id: { organizationId: f.organizationId, id: expenseId } } });
      expect(expense).toMatchObject({ fundingAccountId: bank.id, state: "DRAFT", transactionId: null });
      expect(expense.amount.toFixed(2)).toBe("100.01");
      expect(await tx.financialTransaction.count()).toBe(setup.journals);
    });
    expect(errors).toEqual([]);
  } finally { await fieldContext.close(); await f.db.$disconnect(); }
});
