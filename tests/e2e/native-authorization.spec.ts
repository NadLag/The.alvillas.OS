import { selectPaymentAccount } from "./support/payment-account-picker";
import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { openFieldFixture } from "./support/field-fixture";
import { setPropertyCity } from "./support/property-form";
import { ensureReservationRevenuePostingSetup } from "./support/reservation-revenue";

async function captureAction(page: Page, submit: Locator) {
  const nonce = await submit.evaluate(element => element.closest("form")?.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')?.value);
  expect(nonce).toMatch(/^[a-f0-9-]{36}$/u);
  // Background permission checks use the same route and Next-Action header.
  // Capture this financial form's actual nonce rather than the next route POST.
  const request = page.waitForRequest(value => value.method() === "POST" && Boolean(value.headers()["next-action"]) &&
    new URL(value.url()).pathname.endsWith("/reservations") && Boolean(nonce && value.postData()?.includes(nonce)));
  await submit.click(); const captured = await request, headers = captured.headers(), body = captured.postDataBuffer();
  expect(Boolean(body && headers["next-action"] && headers["content-type"])).toBe(true);
  // Only the observed public action reference and payload are reused. The
  // employee request supplies its own independently authenticated cookies.
  return { url: captured.url(), body: body!, headers: { "content-type": headers["content-type"], "next-action": headers["next-action"],
    accept: "text/x-component", origin: new URL(captured.url()).origin } };
}

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native business actions deny an independent field session and expired grants in ${locale}`, async ({ page: admin, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required"); test.setTimeout(360000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Authorization fixtures require local PostgreSQL");
  const f = await openFieldFixture(admin, info, "en"), origin = new URL(admin.url()).origin, suffix = randomUUID().slice(0, 8);
  const context = await browser.newContext({ baseURL: origin, serviceWorkers: "allow", storageState: { cookies: [], origins: [] },
    viewport: { width: info.project.name === "field-mobile" ? 360 : 1440, height: 900 } });
  const employee = await context.newPage(), phone = `+21266${randomInt(1_000_000, 10_000_000)}`, pin = "368247";
  const ownerName = `Private authorization owner ${suffix}`, ownerEmail = `guard-owner-${suffix}@example.test`, propertyName = `Private financial villa ${suffix}`, guestName = `Financial guard guest ${suffix}`;
  const errors: string[] = []; employee.on("pageerror", error => errors.push(error.message));
  try {
    await admin.goto("/en/app/owners"); await admin.getByTestId("owner-display-name").fill(ownerName); await admin.getByTestId("owner-email").fill(ownerEmail);
    await admin.getByTestId("owner-preferred-locale").selectOption(locale); await admin.getByTestId("owner-submit").click(); await expect(admin.getByRole("heading", { name: ownerName, exact: true })).toBeVisible();
    await admin.goto("/en/app/properties"); await admin.getByTestId("property-owner").selectOption({ label: ownerName }); await admin.getByTestId("property-name").fill(propertyName);
    await admin.getByTestId("property-type").fill("Villa"); await admin.getByTestId("property-address").fill("Local authorization fixture"); await setPropertyCity(admin, "Marrakech");
    await admin.getByTestId("property-bedrooms").fill("2"); await admin.getByTestId("property-bathrooms").fill("2"); await admin.getByTestId("property-max-guests").fill("4");
    await admin.getByTestId("property-submit").click(); await expect(admin.getByRole("heading", { name: propertyName, exact: true })).toBeVisible();
    const setup = await ensureReservationRevenuePostingSetup({ ownerEmail, propertyName, password: process.env.ADMIN_PASSWORD ?? "correct horse battery staple" });
    await withTenant(f.db, f.organizationId, tx => new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "ops.reservation_task_templates", scopeType: "property", scopeId: setup.propertyId,
      effectiveFrom: new Date("2020-01-01"), reason: "Explicit local financial guard workflow", value: { tasks: [{ key: "arrival", type: "ARRIVAL_PREPARATION", title: { en: "Arrival", fr: "Arrivée", ar: "الوصول" }, due: "CHECK_IN", priority: "NORMAL", checklist: [] }] } }));
    await admin.goto(`/${locale}/app/reservations`); await admin.getByTestId("reservation-property").selectOption(setup.propertyId); await admin.getByTestId("reservation-guest-name").fill(guestName);
    await admin.getByTestId("reservation-guest-email").fill(`guard-guest-${suffix}@example.test`); await admin.getByTestId("reservation-check-in").fill("2028-06-10"); await admin.getByTestId("reservation-check-out").fill("2028-06-14");
    await admin.getByTestId("reservation-adults").fill("2"); await admin.getByTestId("reservation-children").fill("0"); await admin.getByTestId("reservation-submit").click(); await expect(admin).toHaveURL(/\/app\/operations/u);
    await admin.goto(`/${locale}/app/reservations`); const row = admin.getByTestId("reservation-row").filter({ hasText: guestName });
    await row.getByTestId("reservation-revenue-amount").fill("100.00"); await selectPaymentAccount(row,"reservation-revenue-account",{ label: setup.bankName });
    const bankId = await row.getByTestId("reservation-revenue-account").inputValue();
    const revenue = await captureAction(admin, row.getByTestId("reservation-revenue-submit")); await expect(row.getByTestId("reservation-revenue-posted")).toBeVisible();
    await selectPaymentAccount(admin,"airbnb-settlement-account",bankId); await admin.getByTestId("airbnb-settlement-csv").fill("Invalid private CSV must be rejected before parsing for a restricted actor");
    const settlement = await captureAction(admin, admin.getByTestId("airbnb-settlement-submit")); await expect(admin.getByTestId("airbnb-settlement-form-error")).toBeVisible();

    await admin.goto("/en/app/identity"); await admin.getByTestId("invite-display-name").fill(`Dedicated authorization employee ${suffix}`); await admin.getByTestId("invite-phone").fill(phone);
    await admin.getByTestId("invite-role").selectOption("field_staff"); await admin.getByTestId("invite-scope-type").selectOption("job"); await admin.getByTestId("invite-scope-id").fill(f.taskId);
    await admin.getByTestId("invite-preferred-locale").selectOption(locale); await admin.getByTestId("invite-submit").click();
    const code = (await admin.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim(); expect(Boolean(code)).toBe(true);
    await employee.goto(`/${locale}/activate/${code}`); await employee.getByTestId("activation-phone").fill(phone); await employee.getByTestId("activation-pin").fill(pin); await employee.getByTestId("activation-submit").click();
    await expect(employee).toHaveURL(new RegExp(`/${locale}/login$`, "u")); await employee.goto(`/${locale}/login?surface=field`);
    await employee.getByTestId("login-phone").fill(phone); await employee.getByTestId("login-pin").fill(pin); await employee.getByTestId("login-submit").click(); await expect(employee).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
    const accountSchema = z.object({ user: z.object({ id: z.uuid(), personId: z.uuid(), organizationId: z.uuid() }) });
    const user = accountSchema.parse(await (await employee.request.get("/api/auth/session")).json()).user; expect(user.organizationId).toBe(f.organizationId);
    await withTenant(f.db, f.organizationId, async tx => {
      const account = await tx.userAccount.findUniqueOrThrow({ where: { id: user.id }, include: { authCredentials: true } });
      expect(account.passwordHash).toBeNull(); expect(Boolean(account.authCredentials.find(value => value.type === "PIN")?.secretHash?.startsWith("$argon2id$"))).toBe(true);
    });
    const before = await withTenant(f.db, f.organizationId, async tx => ({ transactions: await tx.financialTransaction.findMany({ orderBy: { id: "asc" }, include: { postings: { orderBy: { id: "asc" } } } }),
      audits: await tx.auditLog.count({ where: { action: { in: ["reservation.revenue.posted", "airbnb.settlement.imported"] } } }) }));
    for (const action of [revenue, settlement]) {
      const response = await employee.request.post(action.url, { headers: action.headers, data: action.body, maxRedirects: 0 });
      expect(response.status()).toBe(200); expect((await response.text()).includes('"messageKey":"forbidden"')).toBe(true);
    }
    for (const path of ["owners", `properties/${setup.propertyId}`]) {
      const response = await employee.goto(`/${locale}/app/${path}`); expect(response!.status()).toBeLessThan(500);
      await expect(employee.getByRole("heading", { name: ownerName, exact: true })).toHaveCount(0); await expect(employee.getByRole("heading", { name: propertyName, exact: true })).toHaveCount(0);
      await expect(employee.getByTestId("owner-submit")).toHaveCount(0); await expect(employee.getByTestId("property-owner-share-submit")).toHaveCount(0);
    }
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.updateMany({ where: { userAccountId: user.id }, data: { validTo: new Date() } }));
    expect(accountSchema.parse(await (await employee.request.get("/api/auth/session")).json()).user.id).toBe(user.id);
    await employee.goto(`/${locale}/app/configuration`); await expect(employee.getByTestId("configuration-denied")).toBeVisible(); await expect(employee.getByTestId("config-rule-create-form")).toHaveCount(0);
    await expect(employee.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr"); expect((await new AxeBuilder({ page: employee }).analyze()).violations).toEqual([]);
    expect(await employee.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const after = await withTenant(f.db, f.organizationId, async tx => ({ transactions: await tx.financialTransaction.findMany({ orderBy: { id: "asc" }, include: { postings: { orderBy: { id: "asc" } } } }),
      audits: await tx.auditLog.count({ where: { action: { in: ["reservation.revenue.posted", "airbnb.settlement.imported"] } } }) }));
    expect(after).toEqual(before); expect(errors).toEqual([]); await employee.screenshot({ path: info.outputPath(`native-authorization-denied-${locale}.png`), fullPage: true });
  } finally { await context.close(); await f.db.$disconnect(); }
});
