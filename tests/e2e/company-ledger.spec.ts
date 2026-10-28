import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { Money } from "@/platform/money/money";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import { calendarDateAt, formatCurrencyAmount } from "@/i18n/format";
import { ensureE2EAdmin, e2eEmail, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`ALVILLAS company ledger reads native company expenses and preserves owner separation in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required");
  test.setTimeout(180000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL is required");
  const email = e2eEmail(`company-ledger-${randomUUID().slice(0, 8)}`, info.project.name), password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
  const org = bootstrapOrganizationId;
  await ensureE2EAdmin(email, password);
  const db = new PrismaClient(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const f = await withTenant(db, org, async tx => {
      for (const code of ["MAD", "EUR"]) await tx.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
      const actor = await tx.userAccount.findFirstOrThrow({ where: { email, organizationId: org } });
      const property = await tx.property.create({ data: { organizationId: org, name: `Dedicated company ledger villa ${randomUUID()}`, addressLine1: "Local acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
      const owner = await tx.owner.create({ data: { organizationId: org, displayName: "Private owner company-ledger acceptance" } });
      await tx.propertyOwner.create({ data: { organizationId: org, propertyId: property.id, ownerId: owner.id } });
      const bank = await tx.ledgerAccount.create({ data: { organizationId: org, code: `COMPANY_QA_BANK_${randomUUID().replaceAll("-", "").toUpperCase()}`, name: `Private funding ${randomUUID()}`, accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
      const config = new ConfigRuleRepository(tx, org);
      await config.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: property.id, effectiveFrom: new Date("2000-01-01"), reason: "Dedicated configured company expense", value: { default_treatment: "ALVILLAS_PAID" } });
      await config.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: property.id, effectiveFrom: new Date("2000-01-01"), reason: "Dedicated configured company approval", value: { thresholds: [] } });
      await config.lockVersion("finance.accounting_periods", "organization");
      const calendar = await config.resolve({ key: "finance.accounting_periods", scopes: [{ scopeType: "organization", scopeId: null }] });
      const current = calendar?.value as { timezone?: string; allow_early_close?: boolean; max_reopen_seconds?: number } | undefined;
      if (current?.timezone !== "Europe/Paris" || current.allow_early_close || current.max_reopen_seconds !== 60) await config.createVersion({ key: "finance.accounting_periods", scopeType: "organization", scopeId: null, effectiveFrom: new Date("2000-01-01"), reason: "Dedicated native historical accounting calendar", value: { timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 60 } });
      const sequence = await nextReferenceNumber(tx, org, "COMPANY_QA"), slot = Number(sequence.split("-").at(-1));
      const sourceOn = new Date(Date.UTC(2017, slot, 15)).toISOString().slice(0, 10);
      return { actor, property, owner, bank, sourceOn };
    });
    if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 900 });
    await page.goto("/en/login"); await waitForE2EAdminLoginWindow(page, email);
    await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await completeE2EAdminMfa(page, email);
    await expect(page).toHaveURL(/\/en\/app/u);
    const path = `/${locale}/app/finance/company-ledger`, query = `?fromOn=${f.sourceOn}&toOn=${f.sourceOn}&timezone=Europe%2FParis&currency=MAD`;
    const privateUrl = new URL(path + query, page.url()).href;
    const unauthenticated = await anonymous.request.get(privateUrl);
    expect(unauthenticated.url()).toContain("/login"); expect(await unauthenticated.text()).not.toContain(f.bank.name);
    await page.goto(path + query);
    await expect(page.getByTestId("company-ledger-empty")).toBeVisible();
    await page.goto(`/${locale}/app/properties/${f.property.id}`);
    await page.getByTestId("property-new-expense").click();
    await expect(page.getByTestId("expense-draft-form")).toBeVisible();
    await page.getByTestId("expense-amount").fill(locale === "en" ? "500.25" : "500,25");
    await page.getByTestId("expense-category").fill("cleaning"); await page.getByTestId("expense-purpose").fill("Private employee compensation details");
    await page.getByTestId("expense-funding-account").selectOption(f.bank.id); await page.getByTestId("expense-occurred-on").fill(f.sourceOn);
    await page.getByTestId("expense-reason").fill("Dedicated configured company expense"); await page.getByTestId("expense-create").click();
    await expect(page.getByTestId("expense-detail-page")).toBeVisible();
    const expenseUrl = page.url(), expenseId = new URL(expenseUrl).pathname.split("/").at(-1)!;
    await page.getByTestId("expense-submit-reason").fill("Dedicated native company expense submission"); await page.getByTestId("expense-submit").click();
    await expect(page.getByTestId("expense-post-form")).toBeVisible();
    await page.getByTestId("expense-post-reason").fill("Dedicated native company expense payment"); await page.getByTestId("expense-post").click();
    await expect(page.getByTestId("expense-void-form")).toBeVisible();
    const original = await withTenant(db, org, async tx => {
      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      expect(expense.state).toBe("POSTED");
      const row = await tx.financialTransaction.findUniqueOrThrow({ where: { id: expense.transactionId! }, include: { postings: { orderBy: { id: "asc" }, include: { ledgerAccount: true } } } });
      expect(row.createdBy).toBe(f.actor.id); expect(row.postings.filter(posting => posting.ledgerAccount.accountType === "ALVILLAS_OWN")).toHaveLength(1);
      expect(row.postings.some(posting => posting.ledgerAccount.code === "OWNER_PAYABLE")).toBe(false); return row;
    });
    await page.goto(path + query);
    const opening = Money.of((await page.getByTestId("company-ledger-openingBalance").getAttribute("data-amount"))!, "MAD");
    await expect(page.getByTestId("company-ledger-closing")).toHaveText(formatCurrencyAmount(locale, opening.subtract(Money.of("500.25", "MAD")).toJSON().amount, "MAD"));
    await expect(page.getByTestId("company-ledger-periodDebits")).toHaveAttribute("data-amount", "500.25");
    await expect(page.getByTestId("company-ledger-periodCredits")).toHaveAttribute("data-amount", "0.00");
    await expect(page.getByTestId("company-ledger-line")).toHaveCount(1);
    await expect(page.getByTestId("company-ledger-running")).toHaveText(formatCurrencyAmount(locale, opening.subtract(Money.of("500.25", "MAD")).toJSON().amount, "MAD"));
    for (const secret of [f.owner.displayName, f.bank.name, "Private employee compensation details"]) await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    await expect(page.getByTestId("company-ledger-page").getByRole("heading", { level: 1 })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(() => {
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".owner-ledger-page input,.owner-ledger-page select")) {
        control.style.fontFamily = "monospace";
        control.style.fontSize = "2em";
      }
    });
    const reflow = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".owner-ledger-page input,.owner-ledger-page select")].map(control => ({ name: control.name, width: control.getBoundingClientRect().width })) }));
    await info.attach("company-ledger-control-reflow.json", { body: JSON.stringify(reflow), contentType: "application/json" });
    expect(reflow.scroll <= reflow.viewport).toBe(true);
    await page.evaluate(() => {
      for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".owner-ledger-page input,.owner-ledger-page select")) {
        control.style.fontFamily = "";
        control.style.fontSize = "";
      }
    });
    await page.screenshot({ path: info.outputPath(`company-ledger-${locale}.png`), fullPage: true });
    await page.evaluate(() => document.documentElement.style.fontSize = "");
    await page.getByTestId("company-ledger-currency").selectOption("EUR"); await page.getByTestId("company-ledger-currency").focus();
    await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
    await page.getByTestId("company-ledger-apply").press("Enter");
    await expect(page.getByTestId("company-ledger-empty")).toBeVisible();
    await page.goto(expenseUrl); await page.getByTestId("expense-void-reason").fill("Dedicated company payment recorded in error"); await page.getByTestId("expense-void").click();
    await expect(page.getByTestId("expense-void-form")).toHaveCount(0);
    // A reversal is a current-period movement; the original historical day remains unchanged.
    await page.goto(path + query);
    const historicalOpening = Money.of((await page.getByTestId("company-ledger-openingBalance").getAttribute("data-amount"))!, "MAD");
    await expect(page.getByTestId("company-ledger-closing")).toHaveText(formatCurrencyAmount(locale, historicalOpening.subtract(Money.of("500.25", "MAD")).toJSON().amount, "MAD"));
    await expect(page.getByTestId("company-ledger-periodDebits")).toHaveAttribute("data-amount", "500.25");
    const today = calendarDateAt(new Date(), "Europe/Paris"), reversalReference = `EXPENSE:${expenseId}:VOID`;
    await page.goto(path + `?fromOn=${today}&toOn=${today}&timezone=Europe%2FParis&currency=MAD`);
    const reversalLine = page.getByTestId("company-ledger-line").filter({ hasText: reversalReference });
    while (!await reversalLine.count() && await page.getByTestId("company-ledger-next").count()) await page.goto((await page.getByTestId("company-ledger-next").getAttribute("href"))!);
    await expect(reversalLine).toBeVisible(); await expect(reversalLine).toContainText(formatCurrencyAmount(locale, "500.25", "MAD"));
    await withTenant(db, org, async tx => {
      expect(await tx.financialTransaction.findUniqueOrThrow({ where: { id: original.id }, include: { postings: { orderBy: { id: "asc" }, include: { ledgerAccount: true } } } })).toEqual(original);
      const companyMovements = await tx.posting.findMany({ where: { organizationId: org, ledgerAccount: { accountType: "ALVILLAS_OWN" }, transaction: { OR: [{ id: original.id }, { reversesTransactionId: original.id }] } } });
      expect(companyMovements).toHaveLength(2);
      expect(companyMovements.reduce((net, posting) => posting.side === "CREDIT" ? net.add(Money.of(posting.amount.toString(), posting.currency)) : net.subtract(Money.of(posting.amount.toString(), posting.currency)), Money.zero("MAD")).toJSON().amount).toBe("0.00");
      expect(await tx.auditLog.count({ where: { action: "finance.company_ledger.viewed", actorId: f.actor.id } })).toBeGreaterThan(2);
      const role = await tx.role.create({ data: { organizationId: org, key: `company_only_${randomUUID()}`, name: "Dedicated company reader" } });
      const permission = await tx.permission.findFirstOrThrow({ where: { key: "company_ledger:view", organizationId: org } });
      await tx.rolePermission.create({ data: { organizationId: org, roleId: role.id, permissionId: permission.id } });
      await tx.roleAssignment.updateMany({ where: { userAccountId: f.actor.id, organizationId: org, archivedAt: null }, data: { archivedAt: new Date() } });
      await tx.roleAssignment.create({ data: { organizationId: org, userAccountId: f.actor.id, personId: f.actor.personId, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    });
    await page.reload(); await expect(page.getByTestId("company-ledger-page")).toBeVisible();
    await withTenant(db, org, tx => tx.roleAssignment.updateMany({ where: { userAccountId: f.actor.id, organizationId: org, archivedAt: null }, data: { validTo: new Date("2020-01-01") } }));
    const denied = await page.request.get(privateUrl); expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(original.reference);
    expect(errors).toEqual([]);
  } finally { await anonymous.close(); await db.$disconnect(); }
});
