import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { openFieldFixture } from "./support/field-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native company invoice automation retains its actual configured review and current source privacy in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated local PostgreSQL required"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, "en"), suffix = randomUUID().slice(0,8), key = `invoice-${suffix}`;
  const number = `INV-AUT-${suffix}`, name = `Actual company invoice supplier ${suffix}`, text = { en, fr, ar }[locale];
  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: { cookies: [], origins: [] } }), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const user = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json()).user;
    await withTenant(f.db, f.organizationId, async tx => {
      await tx.organizationProfile.upsert({ where: { organizationId: f.organizationId }, update: { timezone: "UTC" },
        create: { organizationId: f.organizationId, brandName: "Native company invoice calendar", timezone: "UTC" } });
      const assignments = await tx.roleAssignment.findMany({ where: { userAccountId: user.id, organizationId: f.organizationId, scopeType: "organization", archivedAt: null } });
      expect(assignments.length).toBeGreaterThan(0); const rules = new ConfigRuleRepository(tx, f.organizationId);
      await rules.createVersion({ key: "finance.expense_treatment", scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
        reason: "Actual company invoice automation treatment", value: { default_treatment: "ALVILLAS_PAID" } });
      await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
        reason: "Actual company invoice automation calendar", value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
        reason: "Actual company invoice automation reviewer", value: { thresholds: [{ key: "native_company_invoice", requires_approval_from: ["finance"] }],
          routing: { finance: { people: [], roles: assignments.map(assignment => assignment.roleId), assigned: false, channels: ["in_app"] } } } });
    });
    await page.goto(`/${locale}/app/automations`);
    const form = page.getByTestId("automation-create-form");
    await form.locator('[name="key"]').fill(key); await form.locator('[name="propertyId"]').selectOption("");
    await expect(form.locator('[name="propertyId"] option:checked')).toHaveText(text.Automation.organization);
    await form.getByLabel(text.Automation.nameEn).fill(`Actual invoice review ${suffix}`);
    await form.getByLabel(text.Automation.nameFr).fill(`Validation de facture ${suffix}`);
    await form.getByRole("combobox", { name: text.Automation.event, exact: true }).selectOption("SupplierInvoiceSubmitted");
    await expect(form.getByRole("combobox", { name: text.Automation.event, exact: true }).locator("option:checked")).toHaveText(text.Automation.invoiceSubmittedEvent);
    await form.getByLabel(text.Automation.conditions, { exact: true }).fill(JSON.stringify({ path: "invoice.submitted_by", op: "=", value: user.id }));
    await form.getByLabel(text.Automation.actions, { exact: true }).fill(JSON.stringify([{ key: "actual-review", type: "create_approval_request",
      title: { en: "Actual configured invoice review", fr: "Validation réelle de facture" }, details: { en: "Use the real invoice approval", fr: "Utiliser la validation réelle" } }]));
    await form.locator('[name="lifecycle"]').selectOption("ACTIVE"); await form.locator('[name="reason"]').fill("Configure actual company invoice review automation");
    await form.getByRole("button", { name: text.Automation.save, exact: true }).click();
    await expect(form.getByTestId("automation-feedback")).toHaveText(text.Automation.messages.saved);
    await page.goto(`/${locale}/app/finance/suppliers/new`); await page.getByTestId("supplier-name").fill(name);
    await page.getByTestId("supplier-category").fill("Company services"); await page.getByTestId("supplier-reason").fill("Actual company automation supplier");
    await page.getByTestId("supplier-save").click(); await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
    await page.goto(`/${locale}/app/finance/supplier-invoices/new`); const draft = page.getByTestId("supplier-invoice-form");
    const supplier = draft.getByTestId("invoice-supplier-picker"); await supplier.fill(name);
    await expect(supplier.locator("..").getByRole("option")).toHaveCount(1); await supplier.press("ArrowDown"); await supplier.press("Enter");
    await draft.getByTestId("invoice-number").fill(number); await draft.getByTestId("invoice-issued").fill("2026-10-28");
    await draft.getByTestId("invoice-purpose").fill(`Private company invoice ${suffix}`); await draft.getByTestId("invoice-currency").selectOption("MAD");
    await draft.getByTestId("invoice-line-category").fill("office"); await draft.getByTestId("invoice-line-amount").fill("2400.00");
    await draft.getByTestId("invoice-reason").fill("Actual company invoice without any property allocation"); await draft.getByTestId("invoice-save").click();
    await expect(page.getByTestId("supplier-invoice-detail")).toBeVisible(); const invoiceId = new URL(page.url()).pathname.split("/").at(-1)!;
    const submission = page.getByTestId("supplier-invoice-submission-form"); await submission.getByTestId("invoice-economic-date").fill("2026-10-28");
    await submission.getByTestId("invoice-preview-policy").click(); await expect(submission.getByTestId("invoice-policy-preview")).toBeVisible();
    await submission.getByTestId("invoice-line-review-note").fill("Actual private company line requiring configured finance review");
    await submission.getByTestId("invoice-submit-reason").fill("Submit actual company invoice for its configured review");
    await submission.getByTestId("invoice-submit").click(); await expect(page.getByTestId("invoice-state")).toHaveText(text.SupplierInvoices.states.PENDING_APPROVAL);
    const source = await withTenant(f.db, f.organizationId, async tx => {
      const invoice = await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { currentSubmission: { include: { approval: true } } } });
      const event = await tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: { organizationId: f.organizationId,
        idempotencyKey: `supplier-invoice:${invoice.currentSubmissionId}:SupplierInvoiceSubmitted` } } });
      expect(invoice.currentSubmission?.approval?.id).toBeTruthy(); return { event, approvalId: invoice.currentSubmission!.approval!.id };
    });
    await page.goto(`/${locale}/app/automations`);
    let row = page.getByTestId("automation-rule").filter({ hasText: `automation.rule.${key}` });
    await row.locator('[name="eventId"]').selectOption(source.event.id); await row.getByRole("button", { name: text.Automation.preview, exact: true }).click();
    await expect(row.getByTestId("automation-preview")).toContainText(text.Automation.matched);
    const execute = () => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "tests/e2e/support/automation-worker.cts", f.organizationId, source.event.id],
      { env: process.env, encoding: "utf8" })) as { ids: string[]; statuses: string[] };
    execute(); execute();
    const run = await withTenant(f.db, f.organizationId, async tx => {
      const run = await tx.automationRun.findFirstOrThrow({ where: { ruleKey: `automation.rule.${key}`, eventId: source.event.id } });
      expect(run).toMatchObject({ propertyId: null, status: "SUCCEEDED", outputs: [{ producedIds: [source.approvalId] }] });
      expect(await tx.automationRun.count({ where: { ruleKey: run.ruleKey, eventId: source.event.id } })).toBe(1);
      expect(await tx.expense.count({ where: { id: invoiceId } })).toBe(0); expect(await tx.posting.count({ where: { dimensions: { path: ["supplier_invoice_id"], equals: invoiceId } } })).toBe(0);
      return run;
    });
    await page.reload(); const history = page.getByTestId("automation-run").filter({ hasText: `automation.rule.${key}` }).filter({ hasText: number });
    for (let older = 0; older < 10 && await history.count() === 0; older++) {
      const next = page.getByRole("link", { name: text.Automation.older, exact: true });
      if (await next.count() === 0) break;
      await next.click();
    }
    await expect(history).toHaveCount(1); await history.locator("summary").click(); await expect(history).toContainText(number);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const elements = [...document.querySelectorAll("main *")].flatMap(element => {
        const box = element.getBoundingClientRect();
        if (box.right <= width + 1 && box.left >= -1 && element.scrollWidth <= element.clientWidth + 1) return [];
        const style = getComputedStyle(element);
        return [{ tag: element.tagName, className: element.className, width: box.width, right: box.right, left: box.left,
          client: element.clientWidth, scroll: element.scrollWidth, overflow: style.overflowX,
          minimum: style.minInlineSize, maximum: style.maxInlineSize, whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap }];
      }).slice(0,50);
      return { width, scroll: document.documentElement.scrollWidth, elements };
    });
    if (overflow.scroll > overflow.width) writeFileSync(info.outputPath("automation-reflow.json"), JSON.stringify(overflow, null, 2));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`company-invoice-automation-${locale}.png`), fullPage: true });
    expect((await anonymous.request.get(`/${locale}/app/automations`)).status()).toBe(200);
    expect(await (await anonymous.request.get(`/${locale}/app/automations`)).text()).not.toContain(number);
    await withTenant(f.db, f.organizationId, async tx => {
      const account = await tx.userAccount.findUniqueOrThrow({ where: { id: user.id } });
      const role = await tx.role.create({ data: { organizationId: f.organizationId, key: `invoice_automation_configuration_${suffix}`, name: "Configuration without invoice finance" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.organizationId, key: { in: ["config_rule:view", "config_rule:configure"] } } });
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.organizationId, roleId: role.id, permissionId: permission.id })) });
      await tx.roleAssignment.updateMany({ where: { organizationId: f.organizationId, userAccountId: user.id, archivedAt: null }, data: { archivedAt: new Date() } });
      await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: user.id, personId: account.personId, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    });
    await page.evaluate(() => document.documentElement.style.fontSize = ""); await page.reload();
    row = page.getByTestId("automation-rule").filter({ hasText: `automation.rule.${key}` });
    expect(await row.locator('[name="eventId"] option').evaluateAll((options, eventId) => options.some(option => (option as HTMLOptionElement).value === eventId), source.event.id)).toBe(false);
    expect(await page.content()).not.toContain(number);
    await expect(page.getByTestId("automation-run").filter({ hasText: `automation.rule.${key}` }).getByText(text.Automation.restrictedOutcome, { exact: true }).first()).toBeVisible();
    expect(await page.content()).not.toContain(source.approvalId);
    expect(await withTenant(f.db, f.organizationId, tx => tx.automationRun.findUniqueOrThrow({ where: { id: run.id } }))).toEqual(run);
    expect(errors).toEqual([]);
  } finally { await anonymous.close(); await f.db.$disconnect(); }
});
