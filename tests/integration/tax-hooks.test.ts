import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import * as auditWriter from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { readTaxHooks } from "@/modules/finance/application/tax-hook-service";
import { TaxHookAccessError, TaxHookChangedError, TaxHookConfigurationError } from "@/modules/finance/domain/tax-hook";
import { TaxHookRepository } from "@/modules/finance/infrastructure/tax-hook-repository";
import { listAuditHistory } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";
import { actualTaxHookFixture } from "./support/tax-hook-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated native tax hook database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });
type Fixture = Awaited<ReturnType<typeof actualTaxHookFixture>>;
const target = (f: Fixture, occurredAt = "2031-05-01T00:00:00Z") => ({ kind: "PROPERTY", propertyId: f.property.id, occurredAt });
const snapshot = (f: Fixture) => withTenant(db, f.org, tx => tx.$queryRaw`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid
  UNION ALL SELECT 'policy',id::text,xmin::text,to_jsonb(c) FROM config_rule c WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);
const version = (f: Fixture, value: unknown, options: { from?: string; to?: string; propertyId?: string; lifecycle?: "DRAFT" | "ACTIVE" } = {}) => withTenant(db, f.org, tx =>
  new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.tax", scopeType: options.propertyId ? "property" : "organization", scopeId: options.propertyId,
    effectiveFrom: new Date(options.from ?? "2031-01-01"), effectiveTo: options.to ? new Date(options.to) : null, lifecycle: options.lifecycle,
    value, createdBy: f.account.id, reason: "Explicit fixture policy version without country tax treatment" }));
const without = (f: Fixture, key: string) => ({ ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(item => item !== key)) } });
const readCount = (f: Fixture) => withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "tax_policy_hook" } }));

describe("native tax interfaces over original versioned policy", () => {
  it("reads exact configured facts from native tax models without changing money or policy history", async () => {
    const f = await actualTaxHookFixture(db, admin), before = await snapshot(f);
    const result = await readTaxHooks(f.ctx, target(f), { db, requestId: randomUUID() });
    expect(result).toMatchObject({ status: "MATCHED", source: { id: f.policy.id, version: f.policy.version }, assessedLiability: null,
      rates: [{ key: "fixture_explicit_policy", amount: "0.07", rateBps: 725, currency: "MAD", serviceAssessment: null }],
      categories: [f.value.taxes[0].tax_hook.category], rules: [{ reference: { policyRuleId: f.policy.id, contextIndex: 0 } }] });
    expect(await snapshot(f)).toEqual(before);
    const logs = await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { resourceType: "tax_policy_hook" } }));
    expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ actorId: f.account.id, action: "finance.tax_hooks.read", resourceId: f.policy.id });
    expect(logs[0].after).toMatchObject({ policyRuleId: f.policy.id, policyVersion: f.policy.version, matchedRules: 1, status: "MATCHED" });
    expect(JSON.stringify(logs[0].after)).not.toContain("rate_bps");
  });
  it("retains property, service and company transaction applicability without inventing a zero liability", async () => {
    const f = await actualTaxHookFixture(db, admin), occurredAt = target(f).occurredAt;
    const service = await readTaxHooks(f.ctx, { kind: "SERVICE", propertyId: f.property.id, serviceKey: "fixture_service", occurredAt }, { db });
    expect(service).toMatchObject({ status: "MATCHED", rules: [{ reference: { contextIndex: 1 } }], assessedLiability: null });
    const transaction = await readTaxHooks(f.ctx, { kind: "TRANSACTION", propertyId: null, transactionType: "fixture_transaction", occurredAt }, { db });
    expect(transaction).toMatchObject({ status: "MATCHED", rules: [{ reference: { contextIndex: 2 } }], assessedLiability: null });
    expect(await readTaxHooks(f.ctx, { kind: "TRANSACTION", propertyId: f.property.id, transactionType: "fixture_transaction", occurredAt }, { db }))
      .toMatchObject({ status: "NO_MATCH", rates: [], rules: [], assessedLiability: null });
    await version(f, { taxes: [{ key: "legacy_configured_tax", rate_bps: 725, currency: "MAD" }] });
    expect(await readTaxHooks(f.ctx, target(f), { db })).toMatchObject({ status: "DEFERRED", deferredTaxKeys: ["legacy_configured_tax"], assessedLiability: null });
    expect(await readTaxHooks(f.ctx, target(f, "2019-12-31T23:59:59Z"), { db })).toMatchObject({ status: "NO_POLICY", source: null, assessedLiability: null });
  });
  it("uses original effective dates and property specificity while preserving earlier native policy versions", async () => {
    const f = await actualTaxHookFixture(db, admin), changed = structuredClone(f.value); changed.taxes[0].amount = "1234567890123456.07";
    const next = await version(f, changed, { propertyId: f.property.id, from: "2031-06-01", to: "2031-07-01" });
    await version(f, changed, { propertyId: f.property.id, from: "2031-01-01", lifecycle: "DRAFT" });
    expect((await readTaxHooks(f.ctx, target(f, "2031-05-31T23:59:59Z"), { db })).source?.id).toBe(f.policy.id);
    expect(await readTaxHooks(f.ctx, target(f, "2031-06-01T00:00:00Z"), { db })).toMatchObject({ source: { id: next.id }, rates: [{ amount: "1234567890123456.07" }] });
    expect((await readTaxHooks(f.ctx, target(f, "2031-07-01T00:00:00Z"), { db })).source?.id).toBe(f.policy.id);
    const original = await withTenant(db, f.org, tx => new TaxHookRepository(tx, f.org).models(f.policy.id));
    expect(original.rates).toHaveLength(1); expect(original.rates[0].configuredValue).toEqual(f.value.taxes[0]);
  });
  it("enforces native tenant isolation even when the view repository is deliberately given another tenant's policy", async () => {
    const f = await actualTaxHookFixture(db, admin), other = await actualTaxHookFixture(db, admin);
    expect(await withTenant(db, f.org, tx => new TaxHookRepository(tx, other.org).models(other.policy.id))).toEqual({ rates: [], categories: [], rules: [] });
    expect(await withTenant(db, f.org, tx => new TaxHookRepository(tx, f.org).models(other.policy.id))).toEqual({ rates: [], categories: [], rules: [] });
    await expect(readTaxHooks(f.ctx, { ...target(f), propertyId: other.property.id }, { db })).rejects.toThrow(TaxHookAccessError);
    expect(await readCount(f)).toBe(0);
    const views = await admin.$queryRaw<Array<{ relname: string; reloptions: string[] }>>`SELECT relname,reloptions FROM pg_class WHERE relname IN('tax_rate','tax_category','tax_rule') ORDER BY relname`;
    expect(views).toHaveLength(3); for (const view of views) expect(view.reloptions).toEqual(expect.arrayContaining(["security_invoker=true", "security_barrier=true"]));
  });
  it("requires each independent held source permission and unconditional organization authority", async () => {
    const f = await actualTaxHookFixture(db, admin);
    for (const key of ["config_rule:view", "financial_transaction:view", "company_ledger:view"])
      await expect(readTaxHooks(without(f, key), target(f), { db })).rejects.toThrow(TaxHookAccessError);
    const narrow = { ...f.ctx, authContext: { ...f.ctx.authContext, scopes: [{ organizationId: f.org, scopeType: "property" as const, scopeId: f.property.id }],
      assignments: f.ctx.authContext.assignments?.map(item => ({ ...item, scope: { organizationId: f.org, scopeType: "property" as const, scopeId: f.property.id } })) } };
    await expect(readTaxHooks(narrow, target(f), { db })).rejects.toThrow(TaxHookAccessError);
    const conditional = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: f.ctx.authContext.assignments?.map(item => ({ ...item, conditions: { assignedToMe: true } })) } };
    await expect(readTaxHooks(conditional, target(f), { db })).rejects.toThrow(TaxHookAccessError);
    await expect(readTaxHooks({ ...f.ctx, actorId: randomUUID() }, target(f), { db })).rejects.toThrow(TaxHookAccessError);
    expect(await readCount(f)).toBe(0);
  });
  it("rejects stale held authority after a stored source permission is revoked", async () => {
    const f = await actualTaxHookFixture(db, admin);
    await withTenant(db, f.org, async tx => { const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "company_ledger:view" } });
      await tx.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); });
    await expect(readTaxHooks(f.ctx, target(f), { db })).rejects.toThrow(TaxHookAccessError); expect(await readCount(f)).toBe(0);
  });
  it("rolls back a read audit if its original policy changes before the final response fence", async () => {
    const f = await actualTaxHookFixture(db, admin), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const row = await original(tx, event); if (event.resourceType === "tax_policy_hook") await version(f, { taxes: [] }); return row;
    });
    try { await expect(readTaxHooks(f.ctx, target(f), { db })).rejects.toThrow(TaxHookChangedError); } finally { spy.mockRestore(); }
    expect(await readCount(f)).toBe(0);
    expect(await readTaxHooks(f.ctx, target(f), { db })).toMatchObject({ status: "DEFERRED", rates: [], assessedLiability: null });
  });
  it("rolls back a read audit when stored source authority is revoked during the response fence", async () => {
    const f = await actualTaxHookFixture(db, admin), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const row = await original(tx, event);
      if (event.resourceType === "tax_policy_hook") await withTenant(db, f.org, async other => {
        const permission = await other.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "company_ledger:view" } });
        await other.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } });
      }); return row;
    });
    try { await expect(readTaxHooks(f.ctx, target(f), { db })).rejects.toThrow(TaxHookAccessError); } finally { spy.mockRestore(); }
    expect(await readCount(f)).toBe(0);
  });
  it("fails closed on malformed optional metadata while keeping original policy and monetary history intact", async () => {
    const f = await actualTaxHookFixture(db, admin);
    await version(f, { taxes: [{ ...f.value.taxes[0], tax_hook: { category: { key: "incomplete" }, contexts: [] } }] });
    const before = await snapshot(f);
    await expect(readTaxHooks(f.ctx, target(f), { db })).rejects.toThrow(TaxHookConfigurationError);
    expect(await snapshot(f)).toEqual(before); expect(await readCount(f)).toBe(0);
  });
  it("masks generic audit details unless original tax configuration and both independent financial roots remain visible", async () => {
    const f = await actualTaxHookFixture(db, admin); await readTaxHooks(f.ctx, target(f), { db });
    const visible = await listAuditHistory(f.ctx, { resourceType: "tax_policy_hook" }, { db });
    expect(visible.rows).toHaveLength(1); expect(visible.rows[0].after).toMatchObject({ policyRuleId: f.policy.id });
    for (const key of ["config_rule:view", "financial_transaction:view", "company_ledger:view"]) {
      const history = await listAuditHistory(without(f, key), { resourceType: "tax_policy_hook" }, { db });
      expect(history.rows).toHaveLength(1); expect(history.rows[0]).toMatchObject({ before: maskedValue, after: maskedValue, reason: maskedValue });
    }
  });
});
