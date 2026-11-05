import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { hashPassword } from "@/platform/auth/password";
import { Money } from "@/platform/money/money";
import { LedgerCalendarRepository } from "@/platform/ledger/ledger-calendar-repository";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { calendarDateAt, formatDate } from "@/i18n/format";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ timezoneId: "America/Denver" });
for (const locale of ["en", "fr", "ar"] as const) test(`original owner statement dates and currency remain exact through filters and locale switches in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL required");
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Owned local statement acceptance database required");
  const db = new PrismaClient(), org = bootstrapOrganizationId, email = "original-owner-" + randomUUID() + "@example.test",
    password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple", labels = ({ en, fr, ar })[locale], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const passwordHash = await hashPassword(password);
    await db.currency.upsert({ where: { code: "EUR" }, update: {}, create: { code: "EUR", name: "Euro", minorUnit: 2 } });
    const f = await withTenant(db, org, async tx => {
      await tx.organizationProfile.upsert({ where: { organizationId: org }, update: {}, create: { organizationId: org, brandName: "Actual statement calendar acceptance", timezone: "UTC" } });
      const person = await tx.person.create({ data: { organizationId: org, displayName: "Actual entitled statement owner" } }),
        account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id, email, passwordHash, status: "ACTIVE" } }),
        owner = await tx.owner.create({ data: { organizationId: org, displayName: "Original statement owner" } }),
        property = await tx.property.create({ data: { organizationId: org, name: "Original calendar villa", addressLine1: "Native statement acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
      await tx.propertyOwner.create({ data: { organizationId: org, ownerId: owner.id, propertyId: property.id, shareBps: 10000, isPrimary: true } });
      await tx.ownerPortalAccess.create({ data: { organizationId: org, userAccountId: account.id, ownerId: owner.id } });
      const calendar = new LedgerCalendarRepository(tx, org), configured = await calendar.configuration(), range = await calendar.range("2026-11-02", "2026-11-02", configured.timezone),
        firstAt = new Date(range.startsAt.getTime() + 30 * 60000).toISOString(), laterAt = new Date(range.startsAt.getTime() + 12 * 3600000).toISOString();
      const repository = new FinanceRepository(tx, org), bank = await repository.ensureLedgerAccount({ code: "STATEMENT_BANK", name: "Original internal custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
        claim = await repository.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Original owner claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" }), dimensions = { owner_id: owner.id, property_id: property.id };
      for (const row of [{ currency: "EUR", amount: "9007199254740993.07", side: "CREDIT", at: firstAt },
        { currency: "EUR", amount: "0.03", side: "DEBIT", at: laterAt }, { currency: "MAD", amount: "0.07", side: "CREDIT", at: laterAt }] as const) {
        const amount = Money.of(row.amount, row.currency), bucket = row.side === "CREDIT" ? "OWNER_REVENUE" : "OWNER_EXPENSE";
        await repository.createFinancialTransaction({ reference: "ORIGINAL-STATEMENT:" + randomUUID(), description: "Actual original document source", occurredAt: new Date(row.at), createdBy: account.id,
          idempotencyKey: randomUUID(), postings: [{ ledgerAccountId: bank.id, amount, side: row.side === "CREDIT" ? "DEBIT" : "CREDIT", bucket, dimensions }, { ledgerAccountId: claim.id, amount, side: row.side, bucket, dimensions }] });
      }
      return { account, property, bank, timezone: configured.timezone };
    });
    const facts = () => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; xmin: string; body: string }>>`
      SELECT 'journal' AS kind,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
      UNION ALL SELECT 'posting',xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,body`), original = await facts();
    await page.goto("/en/login"); await page.getByTestId("login-email").fill(email); await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click(); await expect(page).toHaveURL(/\/en\/app/u);
    await page.goto(`/${locale}/app/owner-portal/properties/${f.property.id}`);
    await expect(page.getByTestId("owner-statement-page")).toBeVisible();
    await expect(page.getByTestId("owner-statement-from")).toHaveValue(calendarDateAt(new Date(), f.timezone).slice(0, 7) + "-01");
    await expect(page.getByTestId("owner-statement-currency")).toHaveValue("MAD");
    await page.getByTestId("owner-statement-from").fill("2026-11-02"); await page.getByTestId("owner-statement-to").fill("2026-11-02");
    await page.getByTestId("owner-statement-currency").selectOption("EUR"); await page.getByTestId("owner-statement-apply").click();
    await expect(page).toHaveURL(/from=2026-11-02&to=2026-11-02&currency=EUR/u);
    await expect(page.getByTestId("owner-statement-opening")).toHaveAttribute("data-amount", "0.00");
    await expect(page.getByTestId("owner-statement-credits")).toHaveAttribute("data-amount", "9007199254740993.07");
    await expect(page.getByTestId("owner-statement-debits")).toHaveAttribute("data-amount", "0.03");
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute("data-amount", "9007199254740993.04");
    await expect(page.getByTestId("owner-statement-line")).toHaveCount(2);
    await expect(page.getByTestId("owner-statement-line").first()).toContainText(formatDate(locale, new Date("2026-11-02T12:00:00Z"), { timeZone: "UTC" }));
    await expect(page.getByText(f.bank.code, { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("owner-statement-filters")).toContainText(labels.OwnerPortal.currency);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath("original-statement.png"), fullPage: true });
    const nextLocale = locale === "fr" ? "ar" : "fr";
    await page.getByTestId("locale-switch-" + nextLocale).click();
    await expect(page).toHaveURL(new RegExp("/" + nextLocale + "/app/owner-portal/properties/" + f.property.id + "\\?from=2026-11-02&to=2026-11-02&currency=EUR", "u"));
    await expect(page.getByTestId("owner-statement-currency")).toHaveValue("EUR");
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute("data-amount", "9007199254740993.04");
    await page.getByTestId("owner-statement-currency").selectOption("MAD"); await page.getByTestId("owner-statement-apply").click();
    await expect(page.getByTestId("owner-statement-closing")).toHaveAttribute("data-amount", "0.07");
    await expect(page.getByTestId("owner-statement-line")).toHaveCount(1);
    await page.goto(`/${nextLocale}/app/owner-portal/properties/${f.property.id}?from=2026-11-03&to=2026-11-02&currency=EUR`);
    await expect(page.getByTestId("owner-statement-page").getByRole("alert")).toContainText(({ en, fr, ar })[nextLocale].OwnerPortal.invalidPeriod);
    await expect(page.getByTestId("owner-statement-from")).toHaveValue(calendarDateAt(new Date(), f.timezone).slice(0, 7) + "-01");
    await expect(page.getByTestId("owner-statement-currency")).toHaveValue("MAD");
    expect(await withTenant(db, org, tx => tx.roleAssignment.count({ where: { userAccountId: f.account.id } }))).toBe(0);
    expect(await facts()).toEqual(original); expect(errors).toEqual([]);
  } finally { await db.$disconnect(); }
});
