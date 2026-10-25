import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { fieldPullResultSchema } from "@/modules/reservations/domain/field-pull";
import { stockPositionSchema } from "@/platform/inventory/field-stocktake";
import { openFieldFixture } from "./support/field-fixture";

test.use({ serviceWorkers: "allow" });
for (const locale of ["en", "fr", "ar"]) test(`Field stocktake HTTP ownership, retry and explicit review in ${locale}`, async ({ page, playwright }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real PostgreSQL required for field stocktake endpoints"); test.setTimeout(240000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Field stocktake fixtures require local PostgreSQL");
  const f = await openFieldFixture(page, info, locale), origin = new URL(page.url()).origin;
  const anonymous = await playwright.request.newContext({ baseURL: origin });
  try {
    const user = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await page.request.get("/api/auth/session")).json()).user;
    const rule = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      return new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "inventory.minimums", scopeType: "property", scopeId: task.propertyId,
        effectiveFrom: new Date("2020-01-01"), createdBy: user.id, reason: "Explicit authenticated linen stocktake acceptance", value: { minimums: [{
          item: `linen_${randomUUID().replaceAll("-", "")}`, quantity: 8, category: "LINEN", unit: "pieces",
          name: { en: "Configured towel", fr: "Serviette configurée", ar: "منشفة محددة" } }] } });
    });
    const params = new URLSearchParams({ organization_id: f.organizationId, actor_user_id: user.id, mode: "assigned", include_linen: "1" });
    const initialResponse = await page.request.get(`/api/sync/pull?${params}`); expect(initialResponse.status()).toBe(200);
    const initial = fieldPullResultSchema.parse(await initialResponse.json()), linen = initial.tasks.find(task => task.id === f.taskId)!.linen!;
    expect(linen.catalog).toEqual({ id: rule.id, version: rule.version }); expect(linen.items).toHaveLength(1);
    const item = linen.items[0]; expect(item).toMatchObject({ quantity: "0", revision: "0", available: true });
    const payload = { taskId: f.taskId, itemKey: item.key, expectedQuantity: item.quantity, expectedRevision: item.revision, countedQuantity: "3",
      unit: item.unit, catalogRuleId: rule.id, catalogVersion: rule.version, note: "Physical linen count retained for safe retries" };
    const op = { type: "field_stocktake.record", client_op_id: randomUUID(), client_created_at: "2077-01-01T00:00:00Z", payload };
    const batch = { organization_id: f.organizationId, actor_user_id: user.id, device_id: randomUUID(), op_schema_version: 1, ops: [op] };
    const result = z.object({ results: z.array(z.object({ client_op_id: z.uuid(), status: z.enum(["APPLIED", "DUPLICATE", "CONFLICT", "REJECTED"]),
      server_version: z.string().nullable(), error_code: z.string().optional(), stocktake: z.object({ expected: stockPositionSchema, current: stockPositionSchema }).optional() })) });
    const post = (value: unknown, requestOrigin = origin) => page.request.post("/api/sync/push", { data: value, headers: { Origin: requestOrigin } });
    expect((await anonymous.post("/api/sync/push", { data: batch })).status()).toBe(401);
    expect((await post(batch, "https://other.example.test")).status()).toBe(403);
    expect((await page.request.post("/api/sync/push", { data: JSON.stringify(batch), headers: { Origin: origin, "Content-Type": "text/plain" } })).status()).toBe(403);
    expect((await post({ ...batch, unexpected: "x".repeat(270000) })).status()).toBe(400);
    expect((await post({ ...batch, ops: [{ ...op, payload: { ...payload, countedQuantity: "3.5" } }] })).status()).toBe(400);
    const forged = await post({ ...batch, organization_id: randomUUID() });
    expect(result.parse(await forged.json()).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_SESSION_CHANGED" });
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(batch)));
    for (const response of responses) { expect(response.status()).toBe(200); expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie"); }
    const statuses = await Promise.all(responses.map(async response => result.parse(await response.json()).results[0].status));
    expect(statuses.filter(status => status === "APPLIED")).toHaveLength(1); expect(statuses.filter(status => status === "DUPLICATE")).toHaveLength(3);
    const changed = await post({ ...batch, ops: [{ ...op, payload: { ...payload, countedQuantity: "4" } }] });
    expect(result.parse(await changed.json()).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_IDEMPOTENCY_KEY_REUSED" });
    const staleOp = { ...op, client_op_id: randomUUID(), payload: { ...payload, countedQuantity: "5" } };
    const stale = await post({ ...batch, ops: [staleOp] }), conflict = result.parse(await stale.json()).results[0];
    expect(conflict).toMatchObject({ status: "CONFLICT", error_code: "STOCKTAKE_CONFLICT", stocktake: {
      expected: { quantity: "0", revision: "0" }, current: { quantity: "3", revision: "1" } } });
    const reviewed = { ...op, client_op_id: randomUUID(), payload: { ...payload, expectedQuantity: "3", expectedRevision: "1", countedQuantity: "5",
      note: "Physical recount after explicit stock conflict review" } };
    expect(result.parse(await (await post({ ...batch, ops: [reviewed] })).json()).results[0]).toMatchObject({ status: "APPLIED", server_version: "2" });
    expect(result.parse(await (await post({ ...batch, ops: [staleOp] })).json()).results[0]).toEqual(conflict);
    params.set("known_tasks", `${f.taskId}.${initial.tasks[0].revision}`);
    const refreshed = fieldPullResultSchema.parse(await (await page.request.get(`/api/sync/pull?${params}`)).json());
    expect(refreshed.known_changes.find(task => task.id === f.taskId)?.linen?.items[0]).toMatchObject({ quantity: "5", revision: "2" });
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.inventoryStocktake.count({ where: { taskId: f.taskId } })).toBe(2);
      expect(await tx.syncOp.count({ where: { deviceId: batch.device_id } })).toBe(3);
      expect(await tx.outboxEvent.count({ where: { type: "StocktakeVariance", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(2);
      expect(await tx.outboxEvent.count({ where: { type: "InventoryBelowMinimum", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(2);
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } })).toMatchObject({ state: "ASSIGNED", completedAt: null });
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: f.taskId } } })).toBe(0);
    });
  } finally { await anonymous.dispose(); await f.db.$disconnect(); }
});
