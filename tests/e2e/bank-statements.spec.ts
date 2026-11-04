import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { bankStatementCommandReceiptSchema } from "@/modules/finance/domain/bank-statement-command";
import { formatCurrencyAmount } from "@/i18n/format";
import { openFieldFixture } from "./support/field-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ actionTimeout: 30000, navigationTimeout: 60000 });
type Fixture = Awaited<ReturnType<typeof openFieldFixture>>;
const originalMoney = (f: Fixture) => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`
 SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid
 UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid
 UNION ALL SELECT 'audit',id::text,xmin::text,to_jsonb(a) FROM audit_log a WHERE organization_id=${f.organizationId}::uuid AND resource_type='financial_transaction' ORDER BY kind,id`);
const originalBank = (f: Fixture, id: string) => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<Array<{ id: string; xmin: string; body: unknown }>>`SELECT id::text,xmin::text,to_jsonb(l) AS body FROM bank_statement_line l WHERE organization_id=${f.organizationId}::uuid AND ledger_account_id=${id}::uuid ORDER BY id`);
async function selectFile(page: Page, name: string, buffer: Buffer) {
  const choosing = page.waitForEvent("filechooser"); await page.getByTestId("bank-file").click();
  await (await choosing).setFiles({ name, mimeType: "application/octet-stream", buffer });
  await expect(page.getByTestId("bank-review")).toBeEnabled(); await page.getByTestId("bank-review").click();
  await expect(page.getByTestId("bank-review-result")).toBeVisible();
  await page.getByTestId("bank-reason").fill("Reviewed the actual original bank statement and its exact source movements");
  await page.getByTestId("bank-confirm").check();
}

for (const locale of ["en", "fr", "ar"] as const) test(`Actual CSV and OFX sources retain duplicate and correction history with private recovery in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated PostgreSQL required"); test.setTimeout(240000);
  if (!["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), marker = randomUUID().slice(0, 8), t = { en, fr, ar }[locale].BankStatements, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const setup = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }), actor = await tx.userAccount.findUniqueOrThrow({ where: { id: task.assignedToUserAccountId! } });
      const finance = new FinanceRepository(tx, f.organizationId), bank = await finance.ensureLedgerAccount({ code: "BANK_STMT_" + marker.toUpperCase(), name: "Actual original bank " + marker, accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
      const bankId = "actual-bank-" + marker, accountId = "actual-source-" + marker;
      await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: await finance.clock(), createdBy: actor.id,
        value: { source: "ORIGINAL_BANK_STATEMENT", accounts: [{ account_code: bank.code, bank_id: bankId, branch_id: null, account_id: accountId, account_type: "CHECKING", currency: "MAD", ofx: true,
          csv: { delimiter: ";", dateFormat: "YYYY-MM-DD", decimalSeparator: ".", groupingSeparator: "", columns: { postedDate: "date", transactionId: "id", reference: "reference", description: "description", currency: "currency", amount: "amount" } } }],
          encoding: "UTF-8", max_bytes: 1000000, max_rows: 5000, matching: { date_window_days: 0, amount_tolerance: "0.00", reference: "EXACT", admission: "EXPLICIT_REVIEW", ledger_effect: "NONE" },
          source_corrections: "APPEND_AND_REOPEN_REVIEW", duplicate_csv_without_id: "RETAIN_EVERY_ROW" }, reason: "Explicit actual bank export identity and retained matching policy" });
      return { bank, bankId, accountId, actorId: actor.id, date: (await finance.clock()).toISOString().slice(0, 10) };
    });
    const firstId = marker + "-original", label = "Actual original source " + marker;
    const csv = Buffer.from(`Date;ID;Reference;Description;Amount;Currency\n${setup.date};${firstId};ref-${marker};${label};0.07;MAD\n${setup.date};${marker}-fee;fee-${marker};Actual original charge ${marker};-0.01;MAD`, "utf8");
    await page.goto(`/${locale}/app`); await page.getByTestId("bank-statements-link").click();
    await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_ready);
    await page.getByTestId("bank-account-open").filter({ hasText: setup.bank.name }).click();
    await selectFile(page, "original-source.csv", csv);
    await expect(page.getByTestId("bank-source-amount").first()).toHaveText(formatCurrencyAmount(locale, "0.07", "MAD"));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`actual-bank-review-${locale}.png`), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    const money = await originalMoney(f), lost = locale === "en", origin = new URL(page.url()).origin;
    let nonce = "";
    if (lost) await page.route("**/api/finance/bank-statements/command", async route => {
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      const receipt = bankStatementCommandReceiptSchema.parse(await response.json()); expect(receipt.state).toBe("SUCCEEDED"); nonce = receipt.idempotencyKey;
      await route.abort("failed");
    }, { times: 1 });
    await page.getByTestId("bank-submit").click();
    const storageKey = `alvillas:bank-statement:${f.organizationId}.${setup.actorId}`;
    if (lost) {
      await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_uncertain);
      expect(nonce).toMatch(/^[a-f0-9-]{36}$/u); expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(nonce);
      await page.reload();
    }
    await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_succeeded);
    await expect(page.getByTestId("bank-import-detail")).toBeVisible();
    expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
    const original = await originalBank(f, setup.bank.id); expect(original).toHaveLength(2);
    await page.getByTestId("bank-command-next").click(); await selectFile(page, "same-original-source.csv", csv);
    await expect(page.getByTestId("bank-reused-rows")).toContainText(new Intl.NumberFormat(locale).format(2));
    await page.getByTestId("bank-submit").click(); await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_succeeded);
    expect(await originalBank(f, setup.bank.id)).toEqual(original);
    await page.getByTestId("bank-command-next").click(); await page.getByTestId("bank-format").selectOption("OFX");
    const date = setup.date.replaceAll("-", ""), correctionId = marker + "-replacement";
    const ofx = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>MAD</CURDEF><BANKACCTFROM><BANKID>${setup.bankId}</BANKID><ACCTID>${setup.accountId}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${date}</DTSTART><DTEND>${date}235959</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>${date}120000[0:GMT]</DTPOSTED><TRNAMT>0.08</TRNAMT><FITID>${correctionId}</FITID><CORRECTFITID>${firstId}</CORRECTFITID><CORRECTACTION>REPLACE</CORRECTACTION><ORIGCURRENCY><CURSYM>EUR</CURSYM><CURRATE>10.250000</CURRATE></ORIGCURRENCY><NAME>Actual bank correction ${marker}</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>0.07</BALAMT><DTASOF>${date}235959</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`, "utf8");
    await selectFile(page, "original-correction.ofx", ofx);
    await expect(page.getByTestId("bank-source-currency-evidence")).toContainText("EUR"); await expect(page.getByTestId("bank-source-currency-evidence")).toContainText("10.250000");
    await page.getByTestId("bank-submit").click();
    await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_succeeded);
    await expect(page.getByTestId("bank-source-amount")).toHaveText(formatCurrencyAmount(locale, "0.08", "MAD"));
    await expect(page.getByTestId("bank-source-currency-evidence")).toContainText("EUR"); await expect(page.getByTestId("bank-source-currency-evidence")).toContainText("10.250000");
    const after = await originalBank(f, setup.bank.id), originalIds = new Set(original.map(row => row.id));
    expect(after).toHaveLength(3); expect(after.filter(row => originalIds.has(row.id))).toEqual(original);
    const afterMoney = await originalMoney(f), moneyIds = new Set(money.map(row => row.kind + ":" + row.id));
    expect(afterMoney.filter(row => moneyIds.has(row.kind + ":" + row.id))).toEqual(money);
    expect(afterMoney.filter(row => row.kind !== "audit")).toEqual(money.filter(row => row.kind !== "audit"));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const foreign = await page.request.post("/api/finance/bank-statements/read", { headers: { Origin: "https://foreign.example.test" }, data: { operation: "ACCOUNTS" } }); expect(foreign.status()).toBe(403);
    const malformed = await page.request.post("/api/finance/bank-statements/read?unexpected=1", { headers: { Origin: origin }, data: { operation: "ACCOUNTS" } }); expect(malformed.status()).toBe(400);
    await page.context().setOffline(true); await expect(page.getByTestId("bank-statement-page").getByRole("alert")).toHaveText(t.privateUnavailable);
    expect(await page.content()).not.toContain(setup.bank.name); expect(await page.content()).not.toContain(label);
    await page.context().setOffline(false); await page.reload(); await expect(page.getByTestId("bank-accounts")).toBeVisible();
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.updateMany({ where: { organizationId: f.organizationId, userAccountId: setup.actorId, archivedAt: null }, data: { archivedAt: new Date() } }));
    await page.reload(); await expect(page.getByTestId("bank-statement-page").getByRole("alert")).toHaveText(t.privateUnavailable);
    expect(await page.content()).not.toContain(setup.bank.name); expect(errors).toEqual([]);
  } catch (error) {
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
      viewport: window.visualViewport ? { width: window.visualViewport.width, height: window.visualViewport.height, scale: window.visualViewport.scale } : null,
      controls: ["bank-file", "bank-review", "bank-submit"].flatMap(id => { const element = document.querySelector(`[data-testid="${id}"]`); if (!element) return [];
        const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return [{ id, rect: rect.toJSON() as unknown, hit: hit ? { tag: hit.tagName, className: hit.className, testId: hit.getAttribute("data-testid") } : null }]; }) })).catch(() => null);
    await info.attach("bank-layout", { body: Buffer.from(JSON.stringify(layout, null, 2)), contentType: "application/json" }); throw error;
  } finally { await page.context().setOffline(false); await f.db.$disconnect(); }
});
