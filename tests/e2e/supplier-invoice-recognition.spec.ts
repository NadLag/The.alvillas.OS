import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { executeSupplierInvoiceRecognitionReference } from "@/modules/finance/application/supplier-invoice-recognition-requests";
import { openFieldFixture } from "./support/field-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

async function choose(picker: Locator, label: string) {
  await picker.fill(label); await expect(picker.locator("..").getByRole("option")).toHaveCount(1);
  await picker.press("ArrowDown"); await picker.press("Enter"); await expect(picker).toHaveValue(label);
}
test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native approved invoice recording survives lost acknowledgements and retains actual financial privacy in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated local PostgreSQL required"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), suffix = randomUUID().slice(0,8), messages = { en, fr, ar }[locale].SupplierInvoices;
  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: { cookies: [], origins: [] } }), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const user = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json()).user;
    const property = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      const property = await tx.property.update({ where: { id: task.propertyId }, data: { timezone: "Europe/Paris" } });
      const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: "Actual original recording owner " + suffix } });
      await tx.propertyOwner.create({ data: { organizationId: f.organizationId, propertyId: property.id, ownerId: owner.id } });
      const rules = new ConfigRuleRepository(tx, f.organizationId);
      await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: property.id, effectiveFrom: new Date("2000-01-01"),
        reason: "Actual original native recording treatment", value: { default_treatment: "OWNER_PAID" } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: property.id, effectiveFrom: new Date("2000-01-01"),
        reason: "Explicit actual native recording review", value: { thresholds: [] } });
      await rules.lockVersion("finance.accounting_periods", "organization", null);
      const calendar = await rules.resolve({ key: "finance.accounting_periods", scopes: [{ scopeType: "organization", scopeId: null }], asOf: await new FinanceRepository(tx, f.organizationId).clock() });
      if (!calendar) await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
        reason: "Actual native recording calendar", value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 } });
      return property;
    });
    if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 900 });
    const supplierName = "Actual recorded invoice supplier " + suffix, number = "INV-RECORD-" + suffix, purpose = "Actual approved original costs " + suffix;
    await page.goto(`/${locale}/app/finance/suppliers/new`); await page.getByTestId("supplier-name").fill(supplierName);
    await page.getByTestId("supplier-category").fill("Maintenance"); await page.getByTestId("supplier-reason").fill("Actual native recording supplier");
    await page.getByTestId("supplier-save").click(); await expect(page.getByRole("heading", { level: 1, name: supplierName, exact: true })).toBeVisible();
    await page.goto(`/${locale}/app/finance/supplier-invoices/new`); const form = page.getByTestId("supplier-invoice-form");
    await choose(form.getByTestId("invoice-supplier-picker"), supplierName); await form.getByTestId("invoice-number").fill(number);
    await form.getByTestId("invoice-issued").fill("2026-10-28"); await form.getByTestId("invoice-purpose").fill(purpose);
    await form.getByTestId("invoice-currency").selectOption("MAD"); await choose(form.getByTestId("invoice-property-picker"), property.name);
    await form.getByTestId("invoice-line-category").fill("maintenance"); await form.getByTestId("invoice-line-amount").fill("2400.01");
    await form.getByTestId("invoice-reason").fill("Actual native original cost source"); await form.getByTestId("invoice-save").click();
    await expect(page.getByTestId("supplier-invoice-detail")).toBeVisible(); const id = new URL(page.url()).pathname.split("/").at(-1)!;
    const submission = page.getByTestId("supplier-invoice-submission-form"); await submission.getByTestId("invoice-economic-date").fill("2026-10-28");
    await submission.getByTestId("invoice-preview-policy").click(); await expect(submission.getByTestId("invoice-policy-preview")).toBeVisible();
    await submission.getByTestId("invoice-line-review-note").fill("Actual original cost review context");
    await submission.getByTestId("invoice-submit-reason").fill("Freeze actual native recording source"); await submission.getByTestId("invoice-submit").click();
    await expect(page.getByTestId("invoice-state")).toHaveText(messages.states.APPROVED);
    const panel = page.getByTestId("invoice-recognition"); await expect(panel.getByTestId("invoice-recognition-state")).toHaveText(messages.recognition.notRecorded);
    const reason = "Record the actual approved original native claim " + suffix; await panel.getByTestId("invoice-recognition-reason").fill(reason);
    await page.context().setOffline(true); await expect(panel.getByTestId("invoice-recognize")).toBeDisabled(); await page.context().setOffline(false);
    await expect(panel.getByTestId("invoice-recognize")).toBeEnabled();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`invoice-recognition-${locale}.png`), fullPage: true }); await page.evaluate(() => document.documentElement.style.fontSize = "");
    let loseResponse = true; const target = `**/${locale}/app/finance/supplier-invoices/${id}`;
    await page.route(target, async route => {
      if (loseResponse && route.request().method() === "POST" && route.request().postData()?.includes(reason)) {
        loseResponse = false; await route.fetch(); await route.abort("failed");
      } else await route.continue();
    });
    const captured = page.waitForRequest(request => request.method() === "POST" && Boolean(request.headers()["next-action"]) && Boolean(request.postData()?.includes(reason)));
    await panel.getByTestId("invoice-recognize").click(); const request = await captured;
    await expect(panel.getByTestId("invoice-recognition-error")).toBeVisible(); await expect(panel.getByTestId("invoice-recognition-reason")).toHaveValue(reason);
    await panel.getByTestId("invoice-recognize").click(); await expect(panel.getByTestId("invoice-recognition-state")).toHaveText(messages.recognition.pending);
    await page.unroute(target); const url = page.url();
    const stored = await withTenant(f.db, f.organizationId, async tx => {
      const requests = await tx.supplierInvoiceRecognitionRequest.findMany({ where: { invoiceId: id } }); expect(requests).toHaveLength(1);
      expect(await tx.supplierInvoiceRecognition.count({ where: { invoiceId: id } })).toBe(0);
      return tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested", payload: { path: ["requestId"], equals: requests[0].id } } });
    });
    const reference = { organizationId: f.organizationId, outboxEventId: stored.id };
    expect(await executeSupplierInvoiceRecognitionReference(reference, { db: f.db })).toMatchObject({ state: "SUCCEEDED", idempotent: false });
    expect(await executeSupplierInvoiceRecognitionReference(reference, { db: f.db })).toMatchObject({ state: "SUCCEEDED", idempotent: true });
    await expect(panel.getByTestId("invoice-recognition-state")).toHaveText(messages.recognition.recorded);
    await expect(panel.getByTestId("invoice-recognized-amount")).toBeVisible(); await expect(panel.getByTestId("invoice-recognize")).toHaveCount(0);
    await page.reload(); await expect(page.getByTestId("invoice-recognition-state")).toHaveText(messages.recognition.recorded);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    const headers = { "content-type": request.headers()["content-type"], "next-action": request.headers()["next-action"] };
    expect(await (await anonymous.request.get(url)).text()).not.toContain(purpose);
    expect(await (await anonymous.request.post(request.url(), { headers, data: request.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    await withTenant(f.db, f.organizationId, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.organizationId, key: "invoice_header_only_" + suffix, name: "Actual independent invoice header viewer" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.organizationId, NOT: { key: { startsWith: "financial_transaction:" } } } });
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.organizationId, roleId: role.id, permissionId: permission.id })) });
      const account = await tx.userAccount.findUniqueOrThrow({ where: { id: user.id } });
      await tx.roleAssignment.updateMany({ where: { userAccountId: user.id, archivedAt: null }, data: { archivedAt: new Date() } });
      await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: user.id, personId: account.personId, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    });
    await page.reload(); await expect(page.getByTestId("invoice-purpose-detail")).toHaveText(purpose); await expect(page.getByTestId("invoice-recognition")).toHaveCount(0);
    expect(await (await page.request.post(request.url(), { headers, data: request.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    await withTenant(f.db, f.organizationId, async tx => {
      const recognition = await tx.supplierInvoiceRecognition.findFirstOrThrow({ where: { invoiceId: id }, include: { lines: { include: { transaction: { include: { postings: { include: { ledgerAccount: true } } } } } } } });
      expect(recognition.lines).toHaveLength(1); const postings = recognition.lines[0].transaction.postings;
      expect(postings.map(posting => posting.amount.toFixed(2))).toEqual(["2400.01", "2400.01"]);
      expect(postings.some(posting => ["ASSET", "ASSET_LOCATION", "STAFF_WALLET"].includes(posting.ledgerAccount.accountType))).toBe(false);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized", resourceId: id } })).toBe(1);
    });
    expect(errors).toEqual([]);
  } finally { await anonymous.close(); await f.db.$disconnect(); }
});
