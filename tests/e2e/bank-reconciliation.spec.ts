import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { formatCurrencyAmount } from "@/i18n/format";
import { bankReconciliationCommandReceiptSchema } from "@/modules/finance/domain/bank-reconciliation-command";
import { bankReconciliationWorkspaceInput, bankReconciliationSourcesSchema } from "@/modules/finance/domain/bank-reconciliation-workspace";
import { openFieldFixture } from "./support/field-fixture";
import { prepareBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ actionTimeout: 30000, navigationTimeout: 60000 });
type Fixture = Awaited<ReturnType<typeof openFieldFixture>>;
async function unchangedSources(f: Fixture, receiptId: string, accountId: string) {
  return withTenant(f.db, f.organizationId, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`
    SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid AND id=${receiptId}::uuid
    UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid AND transaction_id=${receiptId}::uuid
    UNION ALL SELECT 'audit',id::text,xmin::text,to_jsonb(a) FROM audit_log a WHERE organization_id=${f.organizationId}::uuid AND resource_type='financial_transaction' AND resource_id=${receiptId}::uuid
    UNION ALL SELECT 'admission',id::text,xmin::text,to_jsonb(a) FROM bank_statement_admission a WHERE organization_id=${f.organizationId}::uuid AND ledger_account_id=${accountId}::uuid
    UNION ALL SELECT 'import',i.id::text,i.xmin::text,to_jsonb(i) FROM bank_statement_import i JOIN bank_statement_admission a ON a.organization_id=i.organization_id AND a.id=i.admission_id WHERE i.organization_id=${f.organizationId}::uuid AND a.ledger_account_id=${accountId}::uuid
    UNION ALL SELECT 'bank',id::text,xmin::text,to_jsonb(l) FROM bank_statement_line l WHERE organization_id=${f.organizationId}::uuid AND ledger_account_id=${accountId}::uuid
    UNION ALL SELECT 'evidence',e.id::text,e.xmin::text,to_jsonb(e) FROM bank_statement_evidence e JOIN bank_statement_line l ON l.organization_id=e.organization_id AND l.id=e.line_id WHERE e.organization_id=${f.organizationId}::uuid AND l.ledger_account_id=${accountId}::uuid ORDER BY kind,id`);
}
async function review(page: Page, reason: string, amount: string, locale: "en" | "fr" | "ar") {
  await page.getByTestId("bank-match-reason").fill(reason); await page.getByTestId("bank-match-review-button").click();
  await expect(page.getByTestId("bank-match-review")).toBeVisible();
  await expect(page.getByTestId("bank-match-variance").last()).toHaveText(formatCurrencyAmount(locale, "0.00", "MAD"));
  await expect(page.getByTestId("bank-match-review")).toContainText(formatCurrencyAmount(locale, amount, "MAD"));
  await page.getByTestId("bank-match-confirm").check();
}
for (const locale of ["en", "fr", "ar"] as const) test(`Actual grouped and partial bank matching retains exact original history and private recovery in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated PostgreSQL required"); test.setTimeout(240000);
  if (!["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), marker = randomUUID().slice(0, 8), t = { en, fr, ar }[locale].BankReconciliation, b = { en, fr, ar }[locale].BankStatements, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const setup = await prepareBankReconciliationFixture(f, marker, page), first = "Actual first bank movement " + marker, second = "Actual second bank movement " + marker;
    await page.goto(`/${locale}/app/finance/bank-statements`);
    await expect(page.getByTestId("bank-command-status")).toHaveText(b.command_ready);
    await page.getByTestId("bank-account-open").filter({ hasText: setup.bank.name }).click();
    const chooser = page.waitForEvent("filechooser"); await page.getByTestId("bank-file").click();
    await (await chooser).setFiles({ name: "actual-original-split-bank.csv", mimeType: "application/octet-stream", buffer: Buffer.from(`Date;ID;Reference;Description;Amount;Currency\n${setup.date};${marker}-first;actual-first;${first};0.03;MAD\n${setup.date};${marker}-second;actual-second;${second};0.04;MAD`, "utf8") });
    await page.getByTestId("bank-review").click(); await expect(page.getByTestId("bank-review-result")).toBeVisible();
    await page.getByTestId("bank-reason").fill("Retain actual original split bank evidence before matching"); await page.getByTestId("bank-confirm").check(); await page.getByTestId("bank-submit").click();
    await expect(page.getByTestId("bank-command-status")).toHaveText(b.command_succeeded);
    const original = await unchangedSources(f, setup.receiptId, setup.bank.id);
    await page.getByTestId("bank-reconciliation-link").click(); await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_ready);
    await page.getByTestId("bank-match-account").filter({ hasText: setup.bank.name }).click();
    const actual = page.getByTestId("bank-match-sources"), expected = page.getByTestId("bank-match-postings").locator("li").filter({ hasText: setup.reference });
    await actual.locator("li").filter({ hasText: first }).getByRole("checkbox").check(); await actual.locator("li").filter({ hasText: second }).getByRole("checkbox").check();
    await expected.getByRole("checkbox").check(); await review(page, "Group the actual two bank movements with their original receipt " + marker, "0.07", locale);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`actual-bank-match-${locale}.png`), fullPage: true }); await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    let nonce = "";
    if (locale === "en") await page.route("**/api/finance/bank-reconciliation/command", async route => {
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      const receipt = bankReconciliationCommandReceiptSchema.parse(await response.json()); expect(receipt.result.state).toBe("MATCHED"); nonce = receipt.idempotencyKey; await route.abort("failed");
    }, { times: 1 });
    await page.getByTestId("bank-match-submit").click();
    const storageKey = `alvillas:bank-reconciliation:${f.organizationId}.${setup.actor.id}`;
    if (locale === "en") {
      await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_uncertain); expect(nonce).toMatch(/^[a-f0-9-]{36}$/u);
      expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(nonce); await page.reload();
    }
    await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_succeeded); await expect(page.getByTestId("bank-match-source-state")).toHaveText(t.state_MATCHED);
    expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull(); expect(await unchangedSources(f, setup.receiptId, setup.bank.id)).toEqual(original);
    await page.getByTestId("bank-match-new").click(); await page.getByTestId("bank-match-release-reason").fill("Release only the original grouped association for a new partial review"); await page.getByTestId("bank-match-release-confirm").check(); await page.getByTestId("bank-match-release").click();
    await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_succeeded); await expect(page.getByTestId("bank-match-source-state")).toHaveText(t.state_RELEASED);
    await page.getByTestId("bank-match-new").click(); await actual.locator("li").filter({ hasText: first }).getByRole("checkbox").check();
    await expected.getByRole("checkbox").check(); await expected.getByTestId("bank-match-allocation").fill("0.03"); await review(page, "Match only the actual first three cents of the original receipt " + marker, "0.03", locale);
    await page.getByTestId("bank-match-submit").click(); await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_succeeded); await expect(page.getByTestId("bank-match-source-state")).toHaveText(t.state_MATCHED);
    expect(await unchangedSources(f, setup.receiptId, setup.bank.id)).toEqual(original); expect(await page.content()).not.toContain(setup.ownerName);
    const entries = await withTenant(f.db, f.organizationId, tx => tx.bankReconciliationEntry.findMany({ where: { ledgerAccountId: setup.bank.id }, orderBy: { id: "asc" } }));
    expect(entries.map(row => row.action)).toEqual(["MATCH", "RELEASE", "MATCH"]); expect(entries[1].previousEntryId).toBe(entries[0].id);
    const originalCurrencyHistory = await unchangedSources(f, setup.receiptId, setup.bank.id);
    await withTenant(f.db, f.organizationId, async tx => {
      const rules = new ConfigRuleRepository(tx, f.organizationId), now = await new FinanceRepository(tx, f.organizationId).clock(),
        policy = await rules.resolve({ key: "finance.bank_statements", scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
      if (!policy) throw Error("Original bank statement policy required"); const value = bankStatementPolicySchema.parse(policy.value);
      await rules.createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: now, createdBy: setup.actor.id,
        value: { ...value, accounts: value.accounts.map(account => account.account_code === setup.bank.code ? { ...account, currency: "EUR" } : account) }, reason: "Keep original statement currency history visible after configuration changes" });
    });
    await page.reload(); await page.getByTestId("bank-match-account").filter({ hasText: setup.bank.name }).click();
    await expect(page.getByTestId("bank-match-currency").locator("option")).toHaveText(["EUR", "MAD"]);
    await page.getByTestId("bank-match-currency").selectOption("MAD");
    await expect(page.getByTestId("bank-match-historical-currency")).toHaveText(t.historicalCurrency);
    await expect(page.getByTestId("bank-match-sources")).toContainText(first); await expect(page.getByTestId("bank-match-sources")).toContainText(second);
    await expect(page.getByTestId("bank-match-review-button")).toBeDisabled();
    expect(await unchangedSources(f, setup.receiptId, setup.bank.id)).toEqual(originalCurrencyHistory);
    const emptyCurrentSources = page.waitForResponse(response => {
      if (!response.url().endsWith("/api/finance/bank-reconciliation/read") || response.status() !== 200) return false;
      const input = bankReconciliationWorkspaceInput.safeParse(response.request().postDataJSON());
      return input.success && input.data.operation === "SOURCES" && input.data.currency === "EUR";
    });
    await page.getByTestId("bank-match-currency").selectOption("EUR"); expect(bankReconciliationSourcesSchema.parse(await (await emptyCurrentSources).json()).items).toEqual([]);
    await expect(page.getByTestId("bank-match-historical-currency")).toHaveCount(0);
    expect(await unchangedSources(f, setup.receiptId, setup.bank.id)).toEqual(originalCurrencyHistory);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const origin = new URL(page.url()).origin;
    expect((await page.request.post("/api/finance/bank-reconciliation/read", { headers: { Origin: "https://foreign.example.test" }, data: { operation: "HISTORY", accountId: setup.bank.id } })).status()).toBe(403);
    expect((await page.request.post("/api/finance/bank-reconciliation/read?unexpected=1", { headers: { Origin: origin }, data: { operation: "HISTORY", accountId: setup.bank.id } })).status()).toBe(400);
    expect((await page.request.post("/api/finance/bank-reconciliation/read", { headers: { Origin: origin }, data: { operation: "POSTINGS", accountId: setup.refundBank.id, currency: "MAD" } })).status()).toBe(403);
    await page.context().setOffline(true); await expect(page.getByTestId("bank-reconciliation-page").getByRole("alert")).toHaveText(t.privateUnavailable); expect(await page.content()).not.toContain(setup.bank.name); expect(await page.content()).not.toContain(first);
    await page.context().setOffline(false); await page.reload(); await expect(page.getByTestId("bank-match-accounts")).toBeVisible();
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.updateMany({ where: { userAccountId: setup.actor.id, archivedAt: null }, data: { archivedAt: new Date() } }));
    await page.reload(); await expect(page.getByTestId("bank-reconciliation-page").getByRole("alert")).toHaveText(t.privateUnavailable); expect(await page.content()).not.toContain(setup.bank.name); expect(errors).toEqual([]);
  } finally { await page.context().setOffline(false); await f.db.$disconnect(); }
});
