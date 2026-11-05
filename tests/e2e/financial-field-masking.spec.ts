import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { openFieldFixture } from "./support/field-fixture";
import { saveAndOpenTemplate, applyTemplateVersion } from "./support/template-forms";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

for (const locale of ["en", "fr", "ar"] as const) test(`Financial source masking protects configuration and retained template history in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated native PostgreSQL required"); test.setTimeout(240000);
  const f = await openFieldFixture(page, info, locale), errors: string[] = []; page.on("pageerror", error => errors.push(error.name));
  try {
    const task = await withTenant(f.db, f.organizationId, tx => tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })),
      account = await withTenant(f.db, f.organizationId, tx => tx.userAccount.findUniqueOrThrow({ where: { id: task.assignedToUserAccountId! } })),
      reason = "Private original service cost123.45 MAD and treatment", key = "browser_mask_" + randomUUID().replaceAll("-", "");
    await page.goto(`/en/app/templates?kind=SERVICE_CATALOG&property=${task.propertyId}`);
    await page.getByTestId("template-scope").selectOption(task.propertyId); await page.getByTestId("template-add-entry").click();
    const entry = page.getByTestId("template-entry");
    await entry.getByRole("textbox", { name: en.Templates.reference, exact: true }).fill("private_chef");
    await entry.getByRole("textbox", { name: `${en.Templates.name} · ${en.Templates.languages.en}`, exact: true }).fill("Chef");
    await entry.getByRole("textbox", { name: `${en.Templates.name} · ${en.Templates.languages.fr}`, exact: true }).fill("Chef");
    await entry.getByRole("textbox", { name: en.Templates.amount, exact: true }).fill("123.45");
    await entry.getByRole("textbox", { name: en.Templates.currency, exact: true }).fill("MAD");
    await saveAndOpenTemplate(page, key, "Private service " + key.slice(-8), reason); await applyTemplateVersion(page);
    const saved = await withTenant(f.db, f.organizationId, tx => tx.propertyTemplateVersion.findFirstOrThrow({ where: { organizationId: f.organizationId, key } }));
    const fee = await withTenant(f.db, f.organizationId, tx => new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "finance.ota_fee", scopeType: "property", scopeId: task.propertyId,
      effectiveFrom: new Date("2020-01-01"), value: { mode: "FIXED_AMOUNT", amount: "321.09", currency: "MAD" }, createdBy: account.id, reason: "Original company OTA cost321.09 MAD" }));
    const retained = () => withTenant(f.db, f.organizationId, async tx => ({
      template: await tx.propertyTemplateVersion.findUniqueOrThrow({ where: { id: saved.id } }),
      revision: await tx.propertyTemplateRevision.findFirstOrThrow({ where: { propertyId: task.propertyId, kind: "SERVICE_CATALOG" } }),
      fee: await tx.configRule.findUniqueOrThrow({ where: { id: fee.id } })
    })), before = await retained();
    const financialGrant = await withTenant(f.db, f.organizationId, async tx => {
      await tx.roleAssignment.updateMany({ where: { userAccountId: account.id, archivedAt: null }, data: { archivedAt: new Date() } });
      let financialId = "";
      for (const [name, keys, scopeType, scopeId] of [
        ["operational", ["config_rule:view", "config_rule:create", "config_rule:configure", "property:view", "property:edit", "audit_log:view", "audit_log:export"], "organization", null],
        ["financial", ["financial_transaction:view", "company_ledger:view"], "property", task.propertyId]
      ] as const) {
        const permissions = await tx.permission.findMany({ where: { organizationId: f.organizationId, key: { in: [...keys] } } }); expect(permissions).toHaveLength(keys.length);
        const role = await tx.role.create({ data: { organizationId: f.organizationId, key: "browser_mask_" + name + "_" + randomUUID(), name: "Actual browser source grants",
          rolePermissions: { create: permissions.map(permission => ({ organizationId: f.organizationId, permissionId: permission.id })) } } });
        const grant = await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: account.id, personId: account.personId, roleId: role.id,
          scopeType, scopeId, validFrom: new Date("2020-01-01") } }); if (name === "financial") financialId = grant.id;
      }
      return financialId;
    });
    const detail = `/${locale}/app/templates?kind=SERVICE_CATALOG&property=${task.propertyId}&template=${saved.id}`,
      feeFilter = `ruleKey=finance.ota_fee&ruleScopeType=property&ruleScopeId=${task.propertyId}`;
    await page.goto(detail); await expect(page.getByTestId("template-editor")).toBeVisible();
    await expect(page.getByTestId("template-history-row")).toHaveCount(1); expect((await page.content()).includes("123.45")).toBe(true);
    // Financial rule definitions require complete organization source authority.
    await page.goto(`/${locale}/app/configuration?${feeFilter}`); await expect(page.getByTestId("config-rule-row")).toHaveCount(0);
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.update({ where: { id: financialGrant }, data: { scopeType: "organization", scopeId: null } }));
    const positive = await page.goto(`/${locale}/app/configuration?${feeFilter}&key=finance.ota_fee&scopeType=property&scopeId=${task.propertyId}`);
    await expect(page.getByTestId("config-rule-row")).toHaveCount(1); await expect(page.getByTestId("config-rule-row")).toContainText("321.09");
    await expect(page.getByTestId("config-preview")).toContainText("finance.ota_fee"); expect((await positive!.text()).includes("321.09")).toBe(true);
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.update({ where: { id: financialGrant }, data: { archivedAt: new Date() } }));
    const hidden = await page.goto(`/${locale}/app/templates?kind=SERVICE_CATALOG&q=${saved.key}`);
    await expect(page.getByTestId("template-card")).toHaveCount(1);
    await expect(page.getByTestId("template-card")).toContainText({ en, fr, ar }[locale].Templates.financialRestricted);
    expect((await hidden!.text()).includes("123.45")).toBe(false); expect((await page.content()).includes(reason)).toBe(false);
    const denied = await page.goto(detail); await expect(page.getByTestId("templates-denied")).toBeVisible();
    await expect(page.getByTestId("template-editor")).toHaveCount(0); await expect(page.getByTestId("template-history-row")).toHaveCount(0);
    expect((await denied!.text()).includes("123.45")).toBe(false);
    const config = await page.goto(`/${locale}/app/configuration?${feeFilter}`); await expect(page.getByTestId("config-rule-row")).toHaveCount(0);
    expect((await config!.text()).includes("321.09")).toBe(false);
    await page.goto(`/${locale}/app/configuration?key=finance.ota_fee`); await expect(page.getByTestId("configuration-denied")).toBeVisible();
    const audit = await page.goto(`/${locale}/app/audit?resourceId=${saved.id}`);
    expect((await audit!.text()).includes("123.45")).toBe(false);
    const exported = await page.request.get(`/api/audit/export?resourceId=${saved.id}`); expect(exported.status()).toBe(200);
    expect((await exported.text()).includes("123.45")).toBe(false);
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
    expect(await retained()).toEqual(before); await page.screenshot({ path: info.outputPath("financial-field-masking.png"), fullPage: true });
  } finally { await f.db.$disconnect(); }
});
