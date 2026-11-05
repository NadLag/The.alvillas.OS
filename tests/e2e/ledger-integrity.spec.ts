import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { scheduleLedgerIntegrity } from "@/modules/finance/application/ledger-integrity-service";
import { ledgerIntegrityPolicyKey, ledgerIntegrityRoutingKey } from "@/modules/finance/domain/ledger-integrity";
import { Money } from "@/platform/money/money";
import { e2eEmail, ensureE2EAdmin, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ timezoneId: "America/Denver" });
for (const locale of ["en", "fr", "ar"] as const) test(`nightly integrity failure retains financial history and opens only its authorized audit in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required");
  test.setTimeout(180000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const email = e2eEmail("integrity-" + randomUUID().slice(0, 8), info.project.name), password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
  await ensureE2EAdmin(email, password);
  const db = new PrismaClient(), org = bootstrapOrganizationId, labels = { en, fr, ar }[locale], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const f = await withTenant(db, org, async tx => {
      const account = await tx.userAccount.findFirstOrThrow({ where: { organizationId: org, email } }),
        role = await tx.role.create({ data: { organizationId: org, key: "integrity_qa_" + randomUUID(), name: "Explicit integrity financial authority" } }),
        keys = [...new Set(["config_rule:configure", "config_rule:view", "audit_log:view", ...financialRuleSourceChecks(org, ledgerIntegrityPolicyKey).map(check => check.resource.type + ":" + check.action)])],
        permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } });
      expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
      const grant = await tx.roleAssignment.create({ data: { organizationId: org, personId: account.personId, userAccountId: account.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
      return { account, grant };
    });
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email); await expect(page).toHaveURL(/\/en\/app$/u);
    const routeCount = await withTenant(db, org, tx => tx.configRule.count({ where: { key: ledgerIntegrityRoutingKey } }));
    await page.goto(`/${locale}/app/notifications`); await page.getByTestId("routing-event").selectOption("ledger_integrity_failed");
    await expect(page.getByTestId("routing-in-app")).toBeVisible(); await expect(page.getByTestId("routing-scope")).toBeDisabled();
    await expect(page.getByTestId("routing-assigned")).toHaveCount(0);
    expect(await withTenant(db, org, tx => tx.configRule.count({ where: { key: ledgerIntegrityRoutingKey } }))).toBe(routeCount);
    for (const prefix of ["routing-person-", "routing-role-"]) {
      const checked = page.locator(`[data-testid^="${prefix}"]:checked`);
      while (await checked.count()) await checked.first().uncheck();
    }
    await page.getByTestId(`routing-person-${f.account.personId}`).check();
    await page.getByTestId("routing-in-app").check(); await page.getByTestId("routing-email").check(); await page.getByTestId("routing-push").uncheck();
    await page.getByTestId("routing-reason").fill("Explicit owner failure audience for original native integrity acceptance");
    await page.getByTestId("routing-save").click(); await expect(page.getByTestId("routing-status")).toHaveText(labels.Notifications.routing.saved);
    expect(await withTenant(db, org, tx => tx.configRule.count({ where: { key: ledgerIntegrityRoutingKey } }))).toBe(routeCount + 1);
    const source = await withTenant(db, org, async tx => {
      const rules = new ConfigRuleRepository(tx, org), finance = new FinanceRepository(tx, org);
      await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: f.account.id,
        value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 }, reason: "Explicit current integrity acceptance calendar" });
      const policy = await rules.createVersion({ key: ledgerIntegrityPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: f.account.id,
        value: { run_at: "00:00", page_size: 500, max_findings: 10, account_types: { locations: ["UNCLASSIFIED_LOCATION_QA"], claims: ["CLAIM_OWNERSHIP"], company: ["ALVILLAS_OWN"] } },
        reason: "Detect an intentionally unclassified actual bank without changing source money" }),
        bank = await finance.ensureLedgerAccount({ code: "INTEGRITY_BANK_" + randomUUID(), name: "Original integrity custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
        income = await finance.ensureLedgerAccount({ code: "INTEGRITY_INCOME_" + randomUUID(), name: "Original integrity company source", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" }), amount = Money.of("0.07", "MAD"),
        journal = await finance.createFinancialTransaction({ reference: "INTEGRITY-QA:" + randomUUID(), description: "Original native browser integrity source", occurredAt: new Date(), createdBy: f.account.id, idempotencyKey: randomUUID(),
          postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }, { ledgerAccountId: income.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }] });
      return { policy, journal };
    });
    const facts = () => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; xmin: string; body: string }>>`
      SELECT 'journal' AS kind,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid AND id=${source.journal.id}::uuid
      UNION ALL SELECT 'posting',xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid AND transaction_id=${source.journal.id}::uuid ORDER BY kind,body`), original = await facts(),
      result = await scheduleLedgerIntegrity(org, { db });
    expect(result).toMatchObject({ configured: true, passed: false });
    expect(await scheduleLedgerIntegrity(org, { db })).toEqual(result);
    const run = await withTenant(db, org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: result.runId! } }));
    expect(run.report).toMatchObject({ passed: false, findings: expect.arrayContaining([expect.objectContaining({ code: "UNCLASSIFIED_ACCOUNT" })]) });
    await page.goto(`/${locale}/app`); await page.getByTestId("notification-bell").click();
    const notice = page.getByTestId("notification-item").filter({ hasText: labels.Notifications.kinds.ledger_integrity_failed });
    await expect(notice).toHaveCount(1); await expect(notice.getByRole("button", { name: labels.Notifications.open, exact: true })).toBeEnabled();
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await notice.getByRole("button", { name: labels.Notifications.open, exact: true }).click(); await expect(page).toHaveURL(new RegExp(`/${locale}/app/audit$`, "u"));
    await page.getByTestId("audit-filter-resource-id").fill(source.policy.id); await page.getByTestId("audit-filter-submit").click();
    await expect(page.getByTestId("audit-row").filter({ hasText: "finance.ledger_integrity.failed" })).toHaveCount(1);
    await withTenant(db, org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    await page.goto(`/${locale}/app`); await page.getByTestId("notification-bell").click();
    await expect(notice.getByRole("button", { name: labels.Notifications.open, exact: true })).toHaveCount(0);
    await expect(notice).toContainText(labels.Notifications.unavailable);
    expect(await facts()).toEqual(original); expect(errors).toEqual([]);
  } finally { await db.$disconnect(); }
});
