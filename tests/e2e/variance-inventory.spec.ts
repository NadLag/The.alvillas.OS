import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { fieldPullResultSchema } from "@/modules/reservations/domain/field-pull";
import { openFieldFixture } from "./support/field-fixture";
import { chooseCenterProvider, findCenterSource } from "./support/variance-center";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };

test.use({ actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Actual operational quantity variance stays separate from financial access in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated PostgreSQL required"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error("Dedicated local PostgreSQL required");
  const f = await openFieldFixture(page, info, locale), t = { en, fr, ar }[locale].VarianceCenter, errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const user = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json()).user;
    const originalMoney = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY id`);
    const beforeMoney = await originalMoney(), rule = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      return new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "inventory.minimums", scopeType: "property", scopeId: task.propertyId,
        effectiveFrom: new Date("2020-01-01"), createdBy: user.id, reason: "Actual physical variance acceptance catalog", value: { minimums: [{
          item: "actual_variance_" + randomUUID().replaceAll("-", ""), quantity: 8, category: "LINEN", unit: "pieces", name: { en: "Observed towel", fr: "Serviette observée", ar: "منشفة معدودة" } }] } });
    });
    const params = new URLSearchParams({ organization_id: f.organizationId, actor_user_id: user.id, mode: "assigned", include_linen: "1" });
    const pulled = await page.request.get(`/api/sync/pull?${params}`); expect(pulled.ok()).toBe(true);
    const source = fieldPullResultSchema.parse(await pulled.json()).tasks.find(task => task.id === f.taskId)!.linen!.items[0];
    const headers = { Origin: new URL(page.url()).origin }, saved = await page.request.post("/api/sync/push", { headers, data: {
      organization_id: f.organizationId, actor_user_id: user.id, device_id: randomUUID(), op_schema_version: 1, ops: [{ type: "field_stocktake.record", client_op_id: randomUUID(), client_created_at: "2077-01-01T00:00:00Z",
        payload: { taskId: f.taskId, itemKey: source.key, expectedQuantity: source.quantity, expectedRevision: source.revision, countedQuantity: "3", unit: source.unit,
          catalogRuleId: rule.id, catalogVersion: rule.version, note: "Retain original actual physical discrepancy for authorized follow-up" } }] } });
    expect(saved.ok()).toBe(true); expect(z.object({ results: z.array(z.object({ status: z.literal("APPLIED") })).length(1) }).parse(await saved.json()).results).toHaveLength(1);
    const original = await withTenant(f.db, f.organizationId, async tx => {
      const stocktake = await tx.inventoryStocktake.findFirstOrThrow({ where: { taskId: f.taskId }, include: { movement: true } }), account = await tx.userAccount.findUniqueOrThrow({ where: { id: user.id } });
      const role = await tx.role.create({ data: { organizationId: f.organizationId, key: "actual_quantity_reviewer_" + randomUUID(), name: "Independent actual operational reviewer" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.organizationId, key: { in: ["task:view", "task:edit", "task:assign", "audit_log:view"] } } }); expect(permissions).toHaveLength(4);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.organizationId, roleId: role.id, permissionId: permission.id })) });
      await tx.roleAssignment.updateMany({ where: { organizationId: f.organizationId, userAccountId: user.id, archivedAt: null }, data: { archivedAt: await new FinanceRepository(tx, f.organizationId).clock() } });
      await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: user.id, personId: account.personId, roleId: role.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
      return stocktake;
    });
    const originalObservation = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(s) AS body FROM inventory_stocktake s WHERE id=${original.id}::uuid UNION ALL SELECT id::text,xmin::text,to_jsonb(m) FROM inventory_movement m WHERE stocktake_id=${original.id}::uuid ORDER BY id`), beforeObservation = await originalObservation();
    for (const provider of ["BANK", "STAFF", "OTA"]) expect((await page.request.post("/api/finance/variance-center/read", { headers, data: { provider } })).status()).toBe(403);
    await page.goto(`/${locale}/app/finance/variances`); await chooseCenterProvider(page, "INVENTORY");
    const entry = await findCenterSource(page, "INVENTORY", original.id);
    await expect(entry.locator("..").getByTestId("variance-center-variance")).toHaveText(new Intl.NumberFormat(locale).format(3)); await entry.click();
    await expect(page.getByTestId("variance-command-state")).toHaveText(t.command_ready);
    await expect(page.getByTestId("variance-expected")).toHaveText(new Intl.NumberFormat(locale).format(0));
    await expect(page.getByTestId("variance-actual")).toHaveText(new Intl.NumberFormat(locale).format(3));
    expect(await page.getByTestId("variance-detail").locator("input,textarea").count()).toBe(0);
    await page.getByTestId("variance-assignee").selectOption(user.id); await page.getByTestId("variance-assignment-reason").fill("Assign original operational quantity follow-up without salary access");
    await page.getByTestId("variance-assign").click(); await expect(page.getByTestId("variance-command-state")).toHaveText(t.command_succeeded);
    await page.getByTestId("variance-new-command").click(); await page.getByTestId("variance-reason").fill("Authorized reviewer inspected the original physical count");
    await page.getByTestId("variance-action").fill("Accept the operational explanation while retaining original observations and movements");
    await page.getByTestId("variance-resolve").click(); await expect(page.getByTestId("variance-command-state")).toHaveText(t.command_succeeded);
    await expect(page.getByTestId("variance-state")).toHaveText(t.status_RESOLVED);
    await page.getByTestId("variance-show-history").click(); await expect(page.getByTestId("variance-history").locator("li")).toHaveCount(2);
    expect(await originalObservation()).toEqual(beforeObservation); expect(await originalMoney()).toEqual(beforeMoney);
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("actual-operational-variance-200-percent.png"), fullPage: true });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); expect(await page.locator("html").getAttribute("dir")).toBe(locale === "ar" ? "rtl" : "ltr"); expect(errors).toEqual([]);
  } finally { await f.db.$disconnect(); }
});
