import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { openFieldFixture } from "./support/field-fixture";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ timezoneId: "America/Denver" });
for (const locale of ["en", "fr", "ar"] as const) test(`scoped configuration history and every workflow task label remain reachable in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required"); test.setTimeout(240000);
  const f = await openFieldFixture(page, info, locale), key = `feature_flag.paging_${randomUUID().replaceAll("-", "")}`;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const propertyId = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      await tx.configRule.createMany({ data: Array.from({ length: 230 }, (_, index) => ({ organizationId: f.organizationId, key, scopeType: "property",
        scopeId: task.propertyId, version: index + 1, value: { enabled: true }, effectiveFrom: new Date(Date.UTC(2020, 0, index + 1)),
        lifecycle: "ACTIVE", reason: "Explicit local configuration paging acceptance" })) }); return task.propertyId;
    });
    await page.goto(`/${locale}/app/configuration`); const filter = page.getByTestId("config-history-filter");
    await page.getByTestId("config-rule-key").selectOption("feature_flag"); await expect(page.getByTestId("config-rule-feature-key")).toBeVisible();
    const defaultInstant = Date.parse((await page.getByTestId("config-rule-effective-from").inputValue()) + "Z");
    expect(Math.abs(defaultInstant - Date.now())).toBeLessThan(120000);
    await expect(page.getByTestId("config-rule-create-form").getByText({ en, fr, ar }[locale].Configuration.form.effectiveFrom, { exact: true })).toContainText("UTC");
    await filter.locator('[name="ruleKey"]').fill(key); await filter.locator('[name="ruleScopeType"]').selectOption("property");
    await filter.locator('[name="ruleScopeId"]').selectOption(propertyId); await filter.locator('button[type="submit"]').click();
    const rows = page.getByTestId("config-rule-row"), versions: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await expect(rows.first()).toHaveAttribute("data-rule-version", String(230 - index * 50));
      const values = await rows.evaluateAll(elements => elements.map(element => Number(element.getAttribute("data-rule-version"))));
      expect(values).toHaveLength(index === 4 ? 30 : 50); versions.push(...values);
      if (index < 4) await page.getByTestId("config-history-next").click();
    }
    expect(versions).toEqual(Array.from({ length: 230 }, (_, index) => 230 - index));
    await expect(page.getByTestId("config-history-next")).toHaveCount(0);
    await page.getByTestId("config-history-previous").click(); await expect(rows.first()).toHaveAttribute("data-rule-version", "80");
    await page.getByTestId("config-history-next").click(); await expect(rows.first()).toHaveAttribute("data-rule-version", "30");
    await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    const utcKey = `${key}_utc`;
    await page.getByTestId("config-rule-key").selectOption("feature_flag"); await page.getByTestId("config-rule-feature-key").fill(utcKey.replace(/^feature_flag\./u, ""));
    await page.locator('input[name="scopeType"][value="organization"]').check(); await page.getByTestId("config-rule-lifecycle").selectOption("DRAFT");
    await page.getByTestId("config-rule-value").fill('{"enabled":true}'); await page.getByTestId("config-rule-effective-from").fill("2026-11-01T01:30");
    await page.getByTestId("config-rule-effective-to").fill("2026-11-02T01:30"); await page.getByTestId("config-rule-reason").fill("Explicit UTC interval from a Denver browser");
    await page.getByTestId("config-rule-submit").click(); await expect(page.getByTestId("config-rule-form-message")).toHaveText({ en, fr, ar }[locale].Configuration.messages.created, { timeout: 30000 });
    const created = await withTenant(f.db, f.organizationId, tx => tx.configRule.findFirstOrThrow({ where: { key: utcKey } }));
    expect(created.effectiveFrom.toISOString()).toBe("2026-11-01T01:30:00.000Z"); expect(created.effectiveTo?.toISOString()).toBe("2026-11-02T01:30:00.000Z");
    await page.goto(`/${locale}/app/templates?property=${propertyId}&kind=WORKFLOW`); await page.getByTestId("template-add-entry").click();
    const messages = { en, fr, ar }[locale].Templates;
    const types = page.getByTestId("template-entry").getByRole("combobox", { name: messages.taskType, exact: true });
    await expect(types.locator("option")).toHaveText(taskTypeSchema.options.map(type => messages.taskTypes[type]));
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await f.db.$disconnect(); }
});
