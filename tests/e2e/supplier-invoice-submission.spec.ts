import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { defaultNotificationPreferences } from "@/platform/notifications/notification-preferences";
import { formatCurrencyAmount } from "@/i18n/format";
import { openFieldFixture } from "./support/field-fixture";
import { ensureE2EAdmin, e2eEmail, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

async function choose(picker: Locator, label: string) {
  await picker.fill(label); await expect(picker.locator("..").getByRole("option")).toHaveCount(1);
  await picker.press("ArrowDown"); await picker.press("Enter"); await expect(picker).toHaveValue(label);
}
test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native supplier invoice review and mandatory owner notice retain their actual source in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL required"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), origin = new URL(page.url()).origin, suffix = randomUUID().slice(0,8);
  const ownerContext = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, viewport: { width: info.project.name === "field-mobile" ? 360 : 1440, height: 900 } });
  const anonymous = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] } });
  const ownerPage = await ownerContext.newPage(), email = e2eEmail(`invoice-owner-${suffix}`, info.project.name), password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
  const messages = { en, fr, ar }[locale], errors: string[] = [];
  for (const current of [page, ownerPage]) current.on("pageerror", error => errors.push(error.message));
  async function login(target: Page) {
    await target.goto(`/${locale}/login`); await waitForE2EAdminLoginWindow(target, email);
    await target.getByTestId("login-email").fill(email); await target.getByTestId("login-password").fill(password);
    await target.getByTestId("login-submit").click(); await completeE2EAdminMfa(target, email); await expect(target).toHaveURL(/\/app(?:\/|$)/u);
  }
  try {
    await ensureE2EAdmin(email, password);
    const fixture = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      const property = await tx.property.update({ where: { id: task.propertyId }, data: { timezone: "Europe/Paris" } });
      const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: `Dedicated invoice owner ${suffix}` } });
      await tx.propertyOwner.create({ data: { organizationId: f.organizationId, ownerId: owner.id, propertyId: property.id } });
      const account = await tx.userAccount.findFirstOrThrow({ where: { organizationId: f.organizationId, email } });
      const role = await tx.role.findFirstOrThrow({ where: { organizationId: f.organizationId, key: "owner" } });
      await tx.roleAssignment.updateMany({ where: { organizationId: f.organizationId, userAccountId: account.id, archivedAt: null }, data: { archivedAt: new Date() } });
      const grant = await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: account.id, personId: account.personId,
        roleId: role.id, scopeType: "owner", scopeId: owner.id, validFrom: new Date("2020-01-01") } });
      const rules = new ConfigRuleRepository(tx, f.organizationId);
      await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: property.id, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated native invoice cost allocation", value: { default_treatment: "OWNER_PAID" } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: property.id, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated native invoice owner review", value: { thresholds: [{ key: "invoice_owner", requires_approval_from: ["owner"] }],
          routing: { owner: { people: [account.personId], roles: [], assigned: false, channels: ["in_app"] } } } });
      return { property, owner, account, grant };
    });
    if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 900 });
    const supplierName = `Actual submitted invoice supplier ${suffix}`;
    await page.goto(`/${locale}/app/finance/suppliers/new`); await page.getByTestId("supplier-name").fill(supplierName);
    await page.getByTestId("supplier-category").fill("Maintenance"); await page.getByTestId("supplier-reason").fill("Actual native submission source supplier");
    await page.getByTestId("supplier-save").click(); await expect(page.getByRole("heading", { level: 1, name: supplierName, exact: true })).toBeVisible();
    const create = async (number: string, emergency: boolean) => {
      await page.goto(`/${locale}/app/finance/supplier-invoices/new`); const form = page.getByTestId("supplier-invoice-form");
      await choose(form.getByTestId("invoice-supplier-picker"), supplierName);
      await form.getByTestId("invoice-number").fill(number); await form.getByTestId("invoice-issued").fill("2026-10-28");
      await form.getByTestId("invoice-purpose").fill(`Private complete invoice header ${suffix}`); await form.getByTestId("invoice-currency").selectOption("MAD");
      await choose(form.getByTestId("invoice-property-picker"), fixture.property.name);
      await form.getByTestId("invoice-line-category").fill("maintenance"); await form.getByTestId("invoice-line-amount").fill("500.25");
      await form.getByTestId("invoice-reason").fill("Actual immutable native invoice source"); await form.getByTestId("invoice-save").click();
      await expect(page.getByTestId("supplier-invoice-detail")).toBeVisible();
      const id = new URL(page.url()).pathname.split("/").at(-1)!, submission = page.getByTestId("supplier-invoice-submission-form");
      await submission.getByTestId("invoice-economic-date").fill("2026-10-28"); if (emergency) await submission.getByTestId("invoice-emergency").check();
      await submission.getByTestId("invoice-preview-policy").click(); await expect(submission.getByTestId("invoice-policy-preview")).toBeVisible();
      await submission.getByTestId("invoice-line-review-note").fill(`Actual private owner cost note ${suffix}`);
      await submission.getByTestId("invoice-submit-reason").fill(`Actual native invoice submission ${suffix}`);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.evaluate(() => document.documentElement.style.fontSize = "200%");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`invoice-submit-${locale}-${emergency}.png`), fullPage: true }); await page.evaluate(() => document.documentElement.style.fontSize = "");
      const captured = page.waitForRequest(request => request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes(`Actual native invoice submission ${suffix}`)));
      await submission.getByTestId("invoice-submit").click(); const request = await captured;
      await expect(page.getByTestId("invoice-state")).toHaveText(messages.SupplierInvoices.states[emergency ? "APPROVED" : "PENDING_APPROVAL"]);
      await expect(submission).toHaveCount(0);
      const headers = { "content-type": request.headers()["content-type"], "next-action": request.headers()["next-action"], accept: "text/x-component", origin };
      for (const response of await Promise.all(Array.from({ length: 4 }, () => page.request.post(request.url(), { data: request.postDataBuffer()!, headers })))) expect(await response.text()).toContain('"idempotent":true');
      expect(await (await anonymous.request.post(request.url(), { data: request.postDataBuffer()!, headers })).text()).toContain('"code":"forbidden"');
      return { id, request, headers };
    };
    const invoice = await create(`INV-REVIEW-${suffix}`, false);
    const source = await withTenant(f.db, f.organizationId, async tx => {
      const row = await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id }, include: { currentSubmission: { include: { approval: true } } } });
      expect(row.currentSubmission?.approval?.id).toBeTruthy(); expect(await tx.supplierInvoiceSubmission.count({ where: { invoiceId: invoice.id } })).toBe(1);
      return row.currentSubmission!;
    });
    await login(ownerPage); await ownerPage.goto(`/${locale}/app/approvals/${source.approval!.id}`);
    await expect(ownerPage.getByTestId("approval-financial-summary")).toContainText(formatCurrencyAmount(locale, "500.25", "MAD"));
    await expect(ownerPage.getByTestId("approval-form")).toContainText(`Actual private owner cost note ${suffix}`);
    expect(await ownerPage.locator("main").innerText()).not.toContain(`Private complete invoice header ${suffix}`);
    expect((await ownerPage.request.get(`/${locale}/app/finance/supplier-invoices/${invoice.id}`)).status()).toBe(404);
    expect(await (await ownerPage.request.post(invoice.request.url(), { data: invoice.request.postDataBuffer()!, headers: invoice.headers })).text()).toContain('"code":"forbidden"');
    await ownerPage.getByTestId("approval-reason").fill("Owner approves the actual invoice cost"); await ownerPage.getByTestId("approval-approve").click();
    await expect(ownerPage.getByTestId("approval-state")).toHaveText(messages.Approvals.states.APPROVED);
    await page.reload(); await expect(page.getByTestId("invoice-state")).toHaveText(messages.SupplierInvoices.states.APPROVED);
    await page.goto(`/${locale}/app/finance/supplier-invoices?q=INV-REVIEW-${suffix}`);
    await expect(page.getByTestId("invoice-row").locator(".status-badge")).toHaveText(messages.SupplierInvoices.states.APPROVED);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.supplierInvoiceSubmission.findUniqueOrThrow({ where: { id: source.id }, include: { approval: true } })).toMatchObject({ snapshot: source.snapshot, approval: { state: "APPROVED" } });
      const defaults = defaultNotificationPreferences(); await new NotificationRepository(tx, f.organizationId).savePreferences(fixture.account.id, { ...defaults, in_app: { ...defaults.in_app, enabled: false, operations: false } });
      await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: fixture.property.id, effectiveFrom: new Date("2020-01-02"),
        reason: "Explicit configured native emergency exception", value: { thresholds: [{ key: "emergency_owner", requires_approval_from: ["owner"], emergency_bypass_owner: true }],
          routing: { owner: { people: [fixture.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } });
    });
    const emergency = await create(`INV-EMERGENCY-${suffix}`, true);
    const notice = await withTenant(f.db, f.organizationId, tx => tx.notification.findFirstOrThrow({ where: { organizationId: f.organizationId, recipientId: fixture.account.id, kind: "supplier_invoice_emergency" } }));
    await ownerPage.goto(`/${locale}/app/notifications/open/${notice.id}`); await expect(ownerPage.getByTestId("supplier-invoice-notice-page")).toBeVisible();
    await expect(ownerPage.getByTestId("invoice-notice-purpose")).toHaveText(`Actual private owner cost note ${suffix}`);
    await expect(ownerPage.getByTestId("invoice-notice-gross")).toHaveText(formatCurrencyAmount(locale, "500.25", "MAD"));
    await expect(ownerPage.getByTestId("invoice-notice-owner-cost")).toHaveText(formatCurrencyAmount(locale, "500.25", "MAD"));
    expect(await ownerPage.locator("main").innerText()).not.toContain(`Private complete invoice header ${suffix}`);
    await expect(ownerPage.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page: ownerPage }).analyze()).violations).toEqual([]);
    await ownerPage.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await ownerPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await ownerPage.screenshot({ path: info.outputPath(`invoice-owner-notice-${locale}.png`), fullPage: true });
    const noticeUrl = ownerPage.url();
    await withTenant(f.db, f.organizationId, async tx => {
      for (const id of [invoice.id, emergency.id]) { expect(await tx.posting.count({ where: { dimensions: { path: ["supplier_invoice_id"], equals: id } } })).toBe(0);
        expect(await tx.expense.count({ where: { id } })).toBe(0); }
      expect(await tx.auditLog.count({ where: { resourceId: emergency.id, action: "finance.supplier_invoice.emergency_owner_notified" } })).toBe(1);
      await tx.roleAssignment.update({ where: { id: fixture.grant.id }, data: { archivedAt: new Date() } });
    });
    const denied = await ownerPage.request.get(noticeUrl); expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(`Actual private owner cost note ${suffix}`);
    expect(errors).toEqual([]);
  } finally { await ownerContext.close(); await anonymous.close(); await f.db.$disconnect(); }
});
