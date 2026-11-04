import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { openFieldFixture } from "./support/field-fixture";

for (const locale of ["en", "fr", "ar"] as const) test(`Authenticated native tax interfaces preserve deferred accounting treatment in ${locale}`, async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated PostgreSQL required");
  const f = await openFieldFixture(page, info, locale), headers = { Origin: new URL(page.url()).origin }, path = "/api/finance/tax-hooks/read";
  try {
    const setup = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      const propertyId = task.propertyId, actorId = task.assignedToUserAccountId!;
      const policy = await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "finance.tax", scopeType: "property", scopeId: propertyId,
        effectiveFrom: new Date("2020-01-01"), createdBy: actorId, reason: "Explicit browser fixture interfaces without country treatment",
        value: { taxes: [{ key: "fixture_tax", amount: "1234567890123456.07", rate_bps: 725, currency: "MAD", tax_hook: {
          category: { key: "fixture_category", labels: { en: "Configured fixture", fr: "Test configuré", ar: "اختبار معد" } },
          contexts: [{ kind: "PROPERTY", properties: { mode: "SELECTED", ids: [propertyId] } },
            { kind: "SERVICE", properties: { mode: "ANY" }, services: { mode: "SELECTED", keys: ["fixture_service"] } },
            { kind: "TRANSACTION", properties: { mode: "ANY" }, transactionTypes: { mode: "SELECTED", keys: ["fixture_transaction"] } }]
        } }] } }); return { propertyId, actorId, policy };
    });
    const original = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw`
      SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid
      UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.organizationId}::uuid
      UNION ALL SELECT 'policy',id::text,xmin::text,to_jsonb(c) FROM config_rule c WHERE id=${setup.policy.id}::uuid ORDER BY kind,id`);
    const before = await original(), base = { propertyId: setup.propertyId, occurredAt: "2031-05-01T00:00:00Z" }, input = { ...base, kind: "PROPERTY" };
    for (const context of [input, { ...base, kind: "SERVICE", serviceKey: "fixture_service" }, { ...base, kind: "TRANSACTION", transactionType: "fixture_transaction" }]) {
      const response = await page.request.post(path, { headers, data: context }); expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("private, no-store"); expect(response.headers().vary).toContain("Cookie");
      expect(await response.json()).toMatchObject({ status: "MATCHED", source: { id: setup.policy.id, version: setup.policy.version },
        rates: [{ key: "fixture_tax", amount: "1234567890123456.07", rateBps: 725, currency: "MAD" }], assessedLiability: null });
    }
    const unmatched = await page.request.post(path, { headers, data: { ...base, kind: "SERVICE", serviceKey: "another_service" } });
    expect(unmatched.status()).toBe(200); expect(await unmatched.json()).toMatchObject({ status: "NO_MATCH", rates: [], assessedLiability: null });
    expect((await page.request.post(path, { headers, data: { ...input, amount: "0.07" } })).status()).toBe(400);
    expect((await page.request.post(path + "?unexpected=1", { headers, data: input })).status()).toBe(400);
    expect((await page.request.post(path, { headers: { Origin: "https://foreign.example.test" }, data: input })).status()).toBe(403);
    expect((await page.request.post(path, { headers, data: { ...input, propertyId: randomUUID() } })).status()).toBe(403);
    expect((await page.request.post(path, { headers: { ...headers, "Content-Type": "application/json" }, data: "{" })).status()).toBe(400);
    expect((await page.request.post(path, { headers, data: { ...input, unexpected: "x".repeat(66000) } })).status()).toBe(400);
    expect((await page.request.get(path)).status()).toBe(405);
    expect(await original()).toEqual(before);
    const audit = await withTenant(f.db, f.organizationId, tx => tx.auditLog.findMany({ where: { resourceType: "tax_policy_hook", actorId: setup.actorId } }));
    expect(audit).toHaveLength(4); expect(audit.every(event => event.resourceId === setup.policy.id)).toBe(true);
    expect(JSON.stringify(audit.map(event => event.after))).not.toContain("1234567890123456.07");
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.updateMany({ where: { userAccountId: setup.actorId, archivedAt: null }, data: { archivedAt: new Date() } }));
    const denied = await page.request.post(path, { headers, data: input }); expect(denied.status()).toBe(403);
    expect(denied.headers()["cache-control"]).toBe("private, no-store"); expect(await denied.json()).toEqual({ error: "forbidden" });
  } finally { await f.db.$disconnect(); }
});
