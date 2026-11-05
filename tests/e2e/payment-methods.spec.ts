import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { guestDepositCommandSchema, type GuestDepositCommand } from "@/modules/finance/domain/guest-deposit-command";
import { formatCurrencyAmount } from "@/i18n/format";
import { openGuestPaymentFixture } from "./support/guest-payment-fixture";
import { forwardBrowserPostOnce } from "./support/forward-browser-post";
import { acknowledgementBarrier } from "./support/acknowledgement-barrier";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
type Fixture = Awaited<ReturnType<typeof openGuestPaymentFixture>>;
const facts = (f: Fixture) => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`
  WITH journals AS (SELECT DISTINCT t.id FROM financial_transaction t JOIN posting p ON p.organization_id=t.organization_id AND p.transaction_id=t.id
    WHERE t.organization_id=${f.organizationId}::uuid AND coalesce(p.dimensions->>'reservation_id',p.dimensions->>'reservationId')=${f.source.reservationId})
  SELECT 'journal' AS kind,t.id::text,t.xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE t.id IN (SELECT id FROM journals)
  UNION ALL SELECT 'posting',p.id::text,p.xmin::text,to_jsonb(p) FROM posting p WHERE p.organization_id=${f.organizationId}::uuid AND p.transaction_id IN (SELECT id FROM journals)
  ORDER BY kind,id`);
async function prepareReceipt(page: Page, f: Fixture, key: string) {
  await page.getByTestId("deposit-create-open").click();
  await page.getByTestId("deposit-source-open").filter({ hasText: f.setup.propertyName }).click();
  await page.getByTestId("deposit-kind").selectOption("stay");
  await page.getByTestId("deposit-received-at").fill(f.receivedAt);
  await page.getByTestId("deposit-account").selectOption(f.setup.bank.id);
  await page.getByTestId("deposit-amount").fill("0.07");
  await page.getByTestId("deposit-currency").selectOption("MAD");
  await expect(page.getByTestId("deposit-method").locator('option[value="disabled-source"]')).toHaveCount(0);
  await expect(page.getByTestId("deposit-method").locator('option[value="eur-transfer"]')).toHaveCount(0);
  await page.getByTestId("deposit-method").selectOption(key);
  await page.getByTestId("deposit-purpose").fill("Original configured receipt " + f.marker);
  await page.getByTestId("deposit-prepare").click();
  await expect(page.getByTestId("deposit-review")).toBeVisible();
  await page.getByTestId("deposit-reason").fill("Record the exact original receipt under its reviewed configured method");
  await page.getByTestId("deposit-confirm").check();
}
async function submit(page: Page, testId: string) {
  const response = page.waitForResponse(row => row.request().method() === "POST" && new URL(row.url()).pathname === "/api/finance/guest-deposits/command");
  await page.getByTestId(testId).click();
  const acknowledged = await response;
  expect(acknowledged.ok()).toBe(true);
  return guestDepositCommandSchema.parse(acknowledged.request().postDataJSON());
}
for (const locale of ["en", "fr", "ar"] as const) test(`Configured bank, manual and selected cash methods retain original admission in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated native PostgreSQL required");
  test.setTimeout(240000);
  const target = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned browser acceptance database required");
  const f = await openGuestPaymentFixture(page, info, locale), t = { en, fr, ar }[locale].GuestDeposits, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  try {
    await page.goto(`/${locale}/app/field/${f.source.taskId}`);
    const cash = page.getByTestId("field-cash");
    await cash.getByTestId("field-cash-amount").fill("0.07");
    await cash.getByTestId("field-cash-payer").fill(f.guestName);
    await cash.getByTestId("field-cash-purpose").fill("Original configured cash " + f.marker);
    await cash.getByTestId("field-cash-save").click();
    await expect(cash.getByTestId("field-cash-receipt")).toHaveCount(1);
    const collection = await withTenant(f.db, f.organizationId, tx => tx.cashCollection.findFirstOrThrow({ where: { organizationId: f.organizationId, taskId: f.source.taskId } })), original = await facts(f);
    await page.goto(`/${locale}/app/finance/guest-deposits`);
    await prepareReceipt(page, f, "wire-confirmed");
    const lost = acknowledgementBarrier(); let first: GuestDepositCommand | undefined;
    await page.route("**/api/finance/guest-deposits/command", async route => {
      try {
        first = guestDepositCommandSchema.parse(route.request().postDataJSON());
        expect(first.operation).toBe("RECEIPT");
        expect(first.operation === "RECEIPT" ? first.input.paymentMethodFingerprint : null).toMatch(/^[a-f0-9]{64}$/u);
        expect(await forwardBrowserPostOnce(route.request())).toBe(200);
        await route.abort(); lost.resolve();
      } catch (error) { lost.reject(error); throw error; }
    }, { times: 1 });
    await page.getByTestId("deposit-submit").click(); await lost.promise;
    await expect(page.getByTestId("deposit-command-status")).toHaveText(t.command_uncertain);
    await f.define(true); await page.reload();
    await expect(page.getByTestId("deposit-command-status")).toHaveText(t.command_succeeded);
    await expect(page.getByTestId("deposit-outstanding")).toHaveText(formatCurrencyAmount(locale, "0.07", "MAD"));
    await page.getByTestId("deposit-command-next").click();
    await prepareReceipt(page, f, "desk-confirmed");
    await expect(page.getByTestId("deposit-method").locator('option[value="wire-confirmed"]')).toHaveCount(0);
    const manual = await submit(page, "deposit-submit");
    expect(manual.operation === "RECEIPT" ? manual.input.method : null).toBe("desk-confirmed");
    await expect(page.getByTestId("deposit-command-status")).toHaveText(t.command_succeeded);
    await page.getByTestId("deposit-command-next").click();
    await page.getByTestId("deposit-create-open").click();
    await page.getByTestId("deposit-sources").getByRole("listitem").filter({ hasText: f.setup.propertyName }).getByTestId("deposit-cash-open").click();
    await page.getByTestId("deposit-cash-source").selectOption(collection.id);
    await page.getByTestId("deposit-cash-kind").selectOption("stay");
    await expect(page.getByTestId("deposit-cash-method")).toHaveValue("");
    await page.getByTestId("deposit-cash-method").selectOption("cash-manager");
    await page.getByTestId("deposit-cash-amount").fill("0.07");
    await page.getByTestId("deposit-cash-purpose").fill("Original selected cash " + f.marker);
    await page.getByTestId("deposit-cash-prepare").click();
    await expect(page.getByTestId("deposit-cash-review")).toBeVisible();
    await page.getByTestId("deposit-cash-reason").fill("Admit only the selected original cash claims without another custody movement");
    await page.getByTestId("deposit-cash-confirm").check();
    const admission = await submit(page, "deposit-cash-submit");
    expect(admission.operation === "ADMIT_CASH" ? admission.input.paymentMethodKey : null).toBe("cash-manager");
    await expect(page.getByTestId("deposit-command-status")).toHaveText(t.command_succeeded);
    if (!first) throw Error("Original submitted bank command required");
    const sources = [first.idempotencyKey, manual.idempotencyKey, admission.idempotencyKey];
    await withTenant(f.db, f.organizationId, async tx => {
      const accepted = await tx.auditLog.findMany({ where: { organizationId: f.organizationId, action: "finance.payment_method.accepted", OR: sources.map(source => ({ after: { path: ["source"], equals: source } })) } });
      expect(accepted).toHaveLength(3);
      expect(accepted.map(row => (row.after as { methodKey: string }).methodKey).sort()).toEqual(["cash-manager", "desk-confirmed", "wire-confirmed"]);
      expect(await tx.configRule.count({ where: { organizationId: f.organizationId, key: "finance.payment_methods", scopeType: "organization" } })).toBe(f.organizationDefinitions);
      const balance = await tx.$queryRaw<Array<{ amount: string }>>`SELECT sum(CASE side WHEN 'DEBIT' THEN amount ELSE -amount END)::text AS amount FROM posting WHERE organization_id=${f.organizationId}::uuid AND ledger_account_id=${collection.custodyAccountId}::uuid AND coalesce(dimensions->>'cash_collection_id',dimensions->>'cashCollectionId')=${collection.id}`;
      expect(balance).toEqual([{ amount: "0.07" }]);
      expect(await tx.cashCollection.count({ where: { organizationId: f.organizationId, taskId: f.source.taskId } })).toBe(1);
    });
    const oldIds = new Set(original.map(row => row.kind + row.id));
    expect((await facts(f)).filter(row => oldIds.has(row.kind + row.id))).toEqual(original);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("configured-original-payments.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await f.db.$disconnect(); }
});
