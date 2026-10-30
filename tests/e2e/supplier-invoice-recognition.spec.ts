import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";
import { closeAccountingPeriod } from "@/modules/finance/application/accounting-period-service";
import { authContextForAccount } from "@/platform/authz/account-context";
import { executeSupplierInvoiceRecognitionReference } from "@/modules/finance/application/supplier-invoice-recognition-requests";
import { localClockLabel } from "@/platform/time/local-instant";
import { formatCurrencyAmount } from "@/i18n/format";
import { openFieldFixture } from "./support/field-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

async function choose(picker: Locator, label: string) {
  await picker.fill(label); await expect(picker.locator("..").getByRole("option")).toHaveCount(1);
  await picker.press("ArrowDown"); await picker.press("Enter"); await expect(picker).toHaveValue(label);
}
test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native approved invoice recording, payments and claim reversal retain exact history and financial privacy in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated local PostgreSQL required"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), suffix = randomUUID().slice(0,8), messages = { en, fr, ar }[locale].SupplierInvoices;
  const economicDate = locale === "fr" ? "2026-09-15" : "2026-10-28";
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
      return { ...property, accountingTimezone: calendar ? z.object({ timezone: z.string() }).parse(calendar.value).timezone : "UTC" };
    });
    if (locale === "fr") {
      const actor = { organizationId: f.organizationId, actorId: user.id, authContext: await authContextForAccount(f.organizationId, user.id, { db: f.db }) };
      await withTenant(f.db, f.organizationId, async tx => {
        const periods = new AccountingPeriodRepository(tx, f.organizationId); await periods.lock();
        if (await periods.postingOpen(new Date("2026-09-15T12:00:00Z")))
          await closeAccountingPeriod(actor, { month: "2026-09", expectedVersion: 0, idempotencyKey: randomUUID(), reason: "Close actual native recording source period" }, { db: { $transaction: work => work(tx) } });
      });
    }
    if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 900 });
    const supplierName = "Actual recorded invoice supplier " + suffix, number = "INV-RECORD-" + suffix, purpose = "Actual approved original costs " + suffix;
    await page.goto(`/${locale}/app/finance/suppliers/new`); await page.getByTestId("supplier-name").fill(supplierName);
    await page.getByTestId("supplier-category").fill("Maintenance"); await page.getByTestId("supplier-reason").fill("Actual native recording supplier");
    await page.getByTestId("supplier-save").click(); await expect(page.getByRole("heading", { level: 1, name: supplierName, exact: true })).toBeVisible();
    await page.goto(`/${locale}/app/finance/supplier-invoices/new`); const form = page.getByTestId("supplier-invoice-form");
    await choose(form.getByTestId("invoice-supplier-picker"), supplierName); await form.getByTestId("invoice-number").fill(number);
    await form.getByTestId("invoice-issued").fill(economicDate); await form.getByTestId("invoice-purpose").fill(purpose);
    await form.getByTestId("invoice-currency").selectOption("MAD"); await choose(form.getByTestId("invoice-property-picker"), property.name);
    await form.getByTestId("invoice-line-category").fill("maintenance"); await form.getByTestId("invoice-line-amount").fill("2400.01");
    await form.getByTestId("invoice-reason").fill("Actual native original cost source"); await form.getByTestId("invoice-save").click();
    await expect(page.getByTestId("supplier-invoice-detail")).toBeVisible(); const id = new URL(page.url()).pathname.split("/").at(-1)!;
    const submission = page.getByTestId("supplier-invoice-submission-form"); await submission.getByTestId("invoice-economic-date").fill(economicDate);
    await submission.getByTestId("invoice-preview-policy").click(); await expect(submission.getByTestId("invoice-policy-preview")).toBeVisible();
    await submission.getByTestId("invoice-line-review-note").fill("Actual original cost review context");
    await submission.getByTestId("invoice-submit-reason").fill("Freeze actual native recording source"); await submission.getByTestId("invoice-submit").click();
    await expect(page.getByTestId("invoice-state")).toHaveText(messages.states.APPROVED);
    const panel = page.getByTestId("invoice-recognition"); await expect(panel.getByTestId("invoice-recognition-state")).toHaveText(messages.recognition.notRecorded);
    const reason = "Record the actual approved original native claim " + suffix; await panel.getByTestId("invoice-recognition-reason").fill(reason);
    if (locale === "fr") {
      const confirmation = panel.getByTestId("invoice-recognition-adjustment"); await expect(confirmation).not.toBeChecked();
      await panel.getByTestId("invoice-recognize").click(); await expect(confirmation).not.toBeChecked();
      expect(await withTenant(f.db, f.organizationId, tx => tx.supplierInvoiceRecognitionRequest.count({ where: { invoiceId: id } }))).toBe(0);
      await confirmation.check();
    }
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
    const bank = await withTenant(f.db, f.organizationId, tx => new FinanceRepository(tx, f.organizationId).ensureLedgerAccount({ code: "PAYMENT_NATIVE_" + suffix.toUpperCase(),
      name: "Actual native supplier bank " + suffix, accountType: "ASSET_LOCATION", normalSide: "DEBIT" }));
    const originals = await withTenant(f.db, f.organizationId, tx => tx.financialTransaction.findMany({ where: { supplierInvoiceRecognitionLine: { recognition: { invoiceId: id } } }, include: { postings: true } }));
    const payments = page.getByTestId("supplier-payment"); await expect(payments.getByTestId("supplier-payment-outstanding")).toBeVisible();
    await payments.getByTestId("supplier-payment-refresh").click();
    await payments.getByTestId("supplier-payment-amount").fill(locale === "fr" ? "1500,01" : locale === "ar" ? "١٥٠٠٫٠١" : "1500.01");
    const paidInstant = locale === "fr" ? "2026-09-25T12:00:00.000Z" : "2026-10-28T12:00:00.000Z";
    const paidLocal = localClockLabel(paidInstant, property.accountingTimezone).replace(/:00$/u, "");
    await payments.getByTestId("supplier-payment-date").fill(paidLocal);
    await payments.getByTestId("supplier-payment-preview").click();
    await payments.getByTestId("supplier-payment-funding-query").fill(bank.name); await payments.getByTestId("supplier-payment-funding-search").click();
    await expect(payments.getByTestId("supplier-payment-funding").locator(`option[value="${bank.id}"]`)).toHaveCount(1);
    await expect(payments.getByTestId("supplier-payment-funding")).toBeEnabled(); await payments.getByTestId("supplier-payment-funding").selectOption(bank.id);
    const paymentReason = "Actual native supplier payment " + suffix; await payments.getByTestId("supplier-payment-reason").fill(paymentReason);
    await payments.getByTestId("supplier-payment-reference").fill("TRANSFER-" + suffix);
    if (locale === "fr") {
      const confirmation = payments.getByTestId("supplier-payment-adjustment"); await expect(confirmation).not.toBeChecked();
      await payments.getByTestId("supplier-payment-submit").click(); await expect(confirmation).not.toBeChecked();
      expect(await withTenant(f.db, f.organizationId, tx => tx.auditLog.count({ where: { action: "finance.supplier_payment.posted", reason: paymentReason } }))).toBe(0); await confirmation.check();
    }
    await page.context().setOffline(true); await expect(payments.getByTestId("supplier-payment-submit")).toBeDisabled(); await page.context().setOffline(false);
    await expect(payments.getByTestId("supplier-payment-submit")).toBeEnabled(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`supplier-payment-${locale}.png`), fullPage: true }); await page.evaluate(() => document.documentElement.style.fontSize = "");
    let losePayment = true, markPaymentLost!: () => void; const paymentLost = new Promise<void>(resolve => { markPaymentLost = resolve; });
    await page.route(target, async route => {
      if (losePayment && route.request().method() === "POST" && route.request().postData()?.includes(paymentReason)) { losePayment = false; await route.fetch(); await route.abort("failed"); markPaymentLost(); }
      else await route.continue();
    });
    const capturedPayment = page.waitForRequest(candidate => candidate.method() === "POST" && Boolean(candidate.headers()["next-action"]) && Boolean(candidate.postData()?.includes(paymentReason)));
    await payments.getByTestId("supplier-payment-submit").click(); const paymentRequest = await capturedPayment; await paymentLost;
    await expect(payments.getByTestId("supplier-payment-retry")).toBeVisible(); await expect(payments.getByTestId("supplier-payment-reason")).toHaveValue(paymentReason);
    await expect(payments.getByTestId("supplier-payment-amount")).toBeDisabled(); await payments.getByTestId("supplier-payment-retry").click();
    await expect(payments.getByTestId("supplier-payment-entry")).toHaveCount(1); await expect(payments.getByTestId("supplier-payment-retry")).toHaveCount(0); await page.unroute(target);
    const paid = await withTenant(f.db, f.organizationId, tx => tx.auditLog.findMany({ where: { action: "finance.supplier_payment.posted", reason: paymentReason } }));
    expect(paid).toHaveLength(1); expect(paid[0].after).toMatchObject({ input: { amount: "1500.01", fundingAccountId: bank.id, paidAt: locale === "fr" ? "2026-09-25T12:00:00.000Z" : "2026-10-28T12:00:00.000Z", currentPeriod: locale === "fr" } });
    const reversalPanel = page.getByTestId("supplier-claim-reversal");
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-form")).toHaveCount(0);
    await expect(reversalPanel).toContainText(messages.reversal.paymentsActive);
    const paymentHeaders = { "content-type": paymentRequest.headers()["content-type"], "next-action": paymentRequest.headers()["next-action"] };
    for (const response of await Promise.all(Array.from({ length: 4 }, () => page.request.post(paymentRequest.url(), { headers: paymentHeaders, data: paymentRequest.postDataBuffer()! })))) expect(await response.text()).toContain('"idempotent":true');
    expect(await (await anonymous.request.post(paymentRequest.url(), { headers: paymentHeaders, data: paymentRequest.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    const voidReason = "Reverse the actual native supplier payment " + suffix; await payments.getByTestId("supplier-payment-void-reason").fill(voidReason); let loseVoid = true, markVoidLost!: () => void;
    const voidLost = new Promise<void>(resolve => { markVoidLost = resolve; });
    await page.route(target, async route => { if (loseVoid && route.request().method() === "POST" && route.request().postData()?.includes(voidReason)) { loseVoid = false; await route.fetch(); await route.abort("failed"); markVoidLost(); } else await route.continue(); });
    await payments.getByTestId("supplier-payment-void").click(); await voidLost; await expect(payments.getByTestId("supplier-payment-retry")).toBeVisible(); await payments.getByTestId("supplier-payment-retry").click();
    await expect(payments.getByTestId("supplier-payment-history")).toContainText(messages.payment.reversed); await expect(payments.getByTestId("supplier-payment-void")).toHaveCount(0);
    await expect(payments.getByTestId("supplier-payment-retry")).toHaveCount(0); await expect(payments.getByTestId("supplier-payment-refresh")).toBeEnabled(); await page.unroute(target);
    await withTenant(f.db, f.organizationId, async tx => {
      const journal = await tx.financialTransaction.findUniqueOrThrow({ where: { id: paid[0].resourceId! }, include: { postings: true, reversedByTransactions: { include: { postings: true } } } });
      expect(journal.postings).toHaveLength(2); expect(journal.reversedByTransactions).toHaveLength(1); expect(journal.reversedByTransactions[0].postings).toHaveLength(2);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_payment.posted", reason: paymentReason } })).toBe(1);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_payment.reversed", reason: voidReason } })).toBe(1);
      expect(await tx.financialTransaction.findMany({ where: { id: { in: originals.map(original => original.id) } }, include: { postings: true } })).toEqual(originals);
    });
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-form")).toBeVisible();
    const claimReason = "Reverse the actual native original supplier claim " + suffix;
    await reversalPanel.getByTestId("supplier-claim-reversal-reason").fill(claimReason);
    const claimConfirmation = reversalPanel.getByTestId("supplier-claim-reversal-confirm"); await expect(claimConfirmation).not.toBeChecked();
    await reversalPanel.getByTestId("supplier-claim-reversal-submit").click();
    expect(await withTenant(f.db, f.organizationId, tx => tx.supplierInvoiceRecognitionRequest.count({ where: { invoiceId: id, operation: "REVERSE" } }))).toBe(0);
    await claimConfirmation.check();
    await page.context().setOffline(true); await expect(reversalPanel.getByTestId("supplier-claim-reversal-submit")).toBeDisabled(); await page.context().setOffline(false);
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-submit")).toBeEnabled(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`supplier-claim-reversal-${locale}.png`), fullPage: true }); await page.evaluate(() => document.documentElement.style.fontSize = "");
    let loseClaim = true, markClaimLost!: () => void; const claimLost = new Promise<void>(resolve => { markClaimLost = resolve; });
    await page.route(target, async route => {
      if (loseClaim && route.request().method() === "POST" && route.request().postData()?.includes(claimReason)) { loseClaim = false; await route.fetch(); await route.abort("failed"); markClaimLost(); }
      else await route.continue();
    });
    const capturedClaim = page.waitForRequest(candidate => candidate.method() === "POST" && Boolean(candidate.headers()["next-action"]) && Boolean(candidate.postData()?.includes(claimReason)));
    await reversalPanel.getByTestId("supplier-claim-reversal-submit").click(); const claimActionRequest = await capturedClaim; await claimLost;
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-retry")).toBeVisible();
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-reason")).toHaveValue(claimReason); await expect(reversalPanel.getByTestId("supplier-claim-reversal-reason")).toBeDisabled(); await expect(claimConfirmation).toBeChecked();
    await reversalPanel.getByTestId("supplier-claim-reversal-retry").click();
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-state")).toHaveText(messages.reversal.pending);
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-retry")).toHaveCount(0); await page.unroute(target);
    const claimRequest = await withTenant(f.db, f.organizationId, async tx => {
      const requests = await tx.supplierInvoiceRecognitionRequest.findMany({ where: { invoiceId: id, operation: "REVERSE" } }); expect(requests).toHaveLength(1); expect(requests[0].reason).toBe(claimReason);
      expect(await tx.financialTransaction.count({ where: { reversesTransactionId: { in: originals.map(original => original.id) } } })).toBe(0);
      return requests[0];
    });
    const claimHeaders = { "content-type": claimActionRequest.headers()["content-type"], "next-action": claimActionRequest.headers()["next-action"] };
    for (const response of await Promise.all(Array.from({ length: 4 }, () => page.request.post(claimActionRequest.url(), { headers: claimHeaders, data: claimActionRequest.postDataBuffer()! })))) expect(await response.text()).toContain('"idempotent":true');
    expect(await (await anonymous.request.post(claimActionRequest.url(), { headers: claimHeaders, data: claimActionRequest.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    const claimEvent = await withTenant(f.db, f.organizationId, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceReversalRequested", payload: { path: ["requestId"], equals: claimRequest.id } } }));
    const claimReference = { organizationId: f.organizationId, outboxEventId: claimEvent.id };
    expect(await executeSupplierInvoiceRecognitionReference(claimReference, { db: f.db, eventType: claimEvent.type })).toMatchObject({ state: "SUCCEEDED", idempotent: false });
    expect(await executeSupplierInvoiceRecognitionReference(claimReference, { db: f.db, eventType: claimEvent.type })).toMatchObject({ state: "SUCCEEDED", idempotent: true });
    expect(await withTenant(f.db, f.organizationId, tx => tx.financialTransaction.count({ where: { reversesTransactionId: { in: originals.map(original => original.id) } } }))).toBe(1);
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-state")).toHaveText(messages.reversal.reversed);
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-history")).toContainText(messages.recognition.states.SUCCEEDED);
    await expect(payments.getByTestId("supplier-payment-outstanding")).toHaveText(messages.payment.outstanding + ": " + formatCurrencyAmount(locale, "0.00", "MAD"));
    await expect(payments.getByText(messages.payment.claimReversed, { exact: true })).toBeVisible(); await expect(payments.getByTestId("supplier-payment-form")).toHaveCount(0);
    await expect(payments.getByTestId("supplier-payment-refresh")).toBeEnabled();
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.financialTransaction.findMany({ where: { id: { in: originals.map(original => original.id) } }, include: { postings: true } })).toEqual(originals);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.reversed", resourceId: id } })).toBe(1);
    });
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
    await payments.getByTestId("supplier-payment-refresh").click(); await expect(payments.getByTestId("supplier-payment-error")).toHaveText(messages.payment.errors.forbidden);
    await expect(payments.getByTestId("supplier-payment-outstanding")).toHaveCount(0); await expect(payments.getByTestId("supplier-payment-history")).toHaveCount(0);
    await reversalPanel.getByTestId("supplier-claim-reversal-refresh").click(); await expect(reversalPanel.getByTestId("supplier-claim-reversal-error")).toHaveText(messages.forbidden);
    await expect(reversalPanel.getByTestId("supplier-claim-reversal-history")).toHaveCount(0); await expect(reversalPanel.getByTestId("supplier-claim-reversal-state")).toHaveCount(0);
    expect(await (await page.request.post(claimActionRequest.url(), { headers: claimHeaders, data: claimActionRequest.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    expect(await (await page.request.post(paymentRequest.url(), { headers: paymentHeaders, data: paymentRequest.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    await page.reload(); await expect(page.getByTestId("invoice-purpose-detail")).toHaveText(purpose); await expect(page.getByTestId("invoice-recognition")).toHaveCount(0);
    expect(await (await page.request.post(request.url(), { headers, data: request.postDataBuffer()! })).text()).toContain('"code":"forbidden"');
    await withTenant(f.db, f.organizationId, async tx => {
      const recognition = await tx.supplierInvoiceRecognition.findFirstOrThrow({ where: { invoiceId: id }, include: { lines: { include: { periodAdjustment: true, transaction: { include: { postings: { include: { ledgerAccount: true } } } } } } } });
      expect(recognition.lines).toHaveLength(1); const postings = recognition.lines[0].transaction.postings;
      if (locale === "fr") {
        expect(recognition.lines[0].periodAdjustment).not.toBeNull();
        expect(recognition.lines[0].transaction.occurredAt.getTime()).toBeGreaterThan(recognition.lines[0].sourceOccurredAt.getTime());
      } else expect(recognition.lines[0].periodAdjustment).toBeNull();
      expect(postings.map(posting => posting.amount.toFixed(2))).toEqual(["2400.01", "2400.01"]);
      expect(postings.some(posting => ["ASSET", "ASSET_LOCATION", "STAFF_WALLET"].includes(posting.ledgerAccount.accountType))).toBe(false);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized", resourceId: id } })).toBe(1);
    });
    expect(errors).toEqual([]);
  } finally { await anonymous.close(); await f.db.$disconnect(); }
});
