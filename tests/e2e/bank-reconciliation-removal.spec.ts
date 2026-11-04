import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { formatCurrencyAmount } from "@/i18n/format";
import { guestDepositReversalReviewSchema } from "@/modules/finance/domain/guest-deposit-workspace";
import { guestDepositCommandSuccessSchema } from "@/modules/finance/domain/guest-deposit-command";
import { openFieldFixture } from "./support/field-fixture";
import { prepareBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ actionTimeout: 30000, navigationTimeout: 60000 });
type Locale = "en" | "fr" | "ar";
async function importSource(page: Page, locale: Locale, bank: string, name: string, content: string) {
  const t = { en, fr, ar }[locale].BankStatements;
  await page.goto(`/${locale}/app/finance/bank-statements`); await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_ready);
  await page.getByTestId("bank-account-open").filter({ hasText: bank }).click();
  if (name.endsWith(".ofx")) await page.getByTestId("bank-format").selectOption("OFX");
  const chooser = page.waitForEvent("filechooser"); await page.getByTestId("bank-file").click();
  await (await chooser).setFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.from(content, "utf8") });
  await page.getByTestId("bank-review").click(); await expect(page.getByTestId("bank-review-result")).toBeVisible();
  await page.getByTestId("bank-reason").fill("Retain the actual original bank correction before reconciliation"); await page.getByTestId("bank-confirm").check(); await page.getByTestId("bank-submit").click();
  await expect(page.getByTestId("bank-command-status")).toHaveText(t.command_succeeded);
}
for (const locale of ["en", "fr", "ar"] as const) test(`Actual bank removal reconciles original opposites without synthetic movements in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated PostgreSQL required"); test.setTimeout(240000);
  if (!["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), marker = randomUUID().slice(0, 8), t = { en, fr, ar }[locale].BankReconciliation, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const setup = await prepareBankReconciliationFixture(f, marker, page), originalId = marker + "-original";
    await importSource(page, locale, setup.bank.name, "actual-original.csv", `Date;ID;Reference;Description;Amount;Currency\n${setup.date};${originalId};actual-source;Actual original bank receipt;0.07;MAD`);
    const headers = { Origin: new URL(page.url()).origin }, reviewed = await page.request.post("/api/finance/guest-deposits/read", { headers, data: { operation: "REVIEW_REVERSE", transactionId: setup.receiptId } });
    expect(reviewed.ok()).toBe(true); const review = guestDepositReversalReviewSchema.parse(await reviewed.json());
    const reversed = await page.request.post("/api/finance/guest-deposits/command", { headers, data: { operation: "REVERSE", input: { transactionId: setup.receiptId, reviewFingerprint: review.reviewFingerprint, reason: "Append the actual original receipt opposite before removal reconciliation" }, idempotencyKey: randomUUID() } });
    expect(reversed.ok()).toBe(true); const opposite = guestDepositCommandSuccessSchema.parse(await reversed.json()), journal = await withTenant(f.db, f.organizationId, tx => tx.financialTransaction.findUniqueOrThrow({ where: { id: opposite.id } }));
    const date = setup.date.replaceAll("-", ""), removal = `<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>MAD</CURDEF><BANKACCTFROM><BANKID>${setup.bankId}</BANKID><ACCTID>${setup.accountId}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${date}</DTSTART><DTEND>${date}</DTEND><STMTTRN><FITID>${marker}-removed</FITID><CORRECTFITID>${originalId}</CORRECTFITID><CORRECTACTION>DELETE</CORRECTACTION><NAME>Actual retained bank removal</NAME></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>0.00</BALAMT><DTASOF>${date}</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    await importSource(page, locale, setup.bank.name, "actual-removal.ofx", removal);
    const snapshot = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`
      SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid AND id IN(${setup.receiptId}::uuid,${opposite.id}::uuid)
      UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid AND transaction_id IN(${setup.receiptId}::uuid,${opposite.id}::uuid)
      UNION ALL SELECT 'source',id::text,xmin::text,to_jsonb(l) FROM bank_statement_line l WHERE organization_id=${f.organizationId}::uuid AND ledger_account_id=${setup.bank.id}::uuid ORDER BY kind,id`);
    const before = await snapshot(); await page.getByTestId("bank-reconciliation-link").click(); await page.getByTestId("bank-match-account").filter({ hasText: setup.bank.name }).click();
    await page.getByTestId("bank-match-removal").check(); await expect(page.getByTestId("bank-match-removal-selection")).toContainText(t.removalEvidence);
    const expected = page.getByTestId("bank-match-postings"); await expected.locator("li").filter({ hasText: setup.reference }).getByRole("checkbox").check(); await expected.locator("li").filter({ hasText: journal.reference }).getByRole("checkbox").check();
    await page.getByTestId("bank-match-reason").fill("Compare the actual retained bank removal with original opposite entries"); await page.getByTestId("bank-match-review-button").click();
    const confirmation = page.getByTestId("bank-match-review"); await expect(confirmation).toBeVisible(); await expect(confirmation.getByTestId("bank-match-removal-evidence")).toHaveText(t.retainedRemovals.replace("{count}", "1"));
    await expect(confirmation.getByTestId("bank-match-variance")).toHaveText(formatCurrencyAmount(locale, "0.00", "MAD")); await page.getByTestId("bank-match-confirm").check();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); await page.getByTestId("bank-match-submit").click(); await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_succeeded);
    await expect(page.getByTestId("bank-match-source-state")).toHaveText(t.state_MATCHED); expect(await snapshot()).toEqual(before);
    const entries = await withTenant(f.db, f.organizationId, async tx => ({ evidence: await tx.bankReconciliationEvidence.findMany({ where: { entry: { ledgerAccountId: setup.bank.id } } }), allocations: await tx.bankReconciliationAllocation.findMany({ where: { entry: { ledgerAccountId: setup.bank.id }, lineId: { not: null } } }) }));
    expect(entries.evidence).toHaveLength(1); expect(entries.allocations).toEqual([]);
    await page.reload(); await page.getByTestId("bank-match-account").filter({ hasText: setup.bank.name }).click(); await page.getByTestId("bank-match-history-open").first().click();
    await expect(page.getByTestId("bank-match-detail").getByTestId("bank-match-removal-evidence")).toBeVisible();
    await page.getByTestId("bank-match-release-reason").fill("Release original bank removal evidence without altering any movement"); await page.getByTestId("bank-match-release-confirm").check(); await page.getByTestId("bank-match-release").click();
    await expect(page.getByTestId("bank-match-command-state")).toHaveText(t.command_succeeded); expect(await snapshot()).toEqual(before);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"); await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`actual-bank-removal-${locale}.png`), fullPage: true });
    await page.context().setOffline(true); await expect(page.getByTestId("bank-reconciliation-page").getByRole("alert")).toHaveText(t.privateUnavailable); expect(await page.content()).not.toContain(setup.bank.name); expect(errors).toEqual([]);
  } finally { await page.context().setOffline(false); await f.db.$disconnect(); }
});
