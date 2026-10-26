import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { provisionIntegrationRole } from "./support/database-role";
import { ConfigAuthorizationError, ConfigValidationError, getConfigAdminModel, configAdminPageSize } from "@/modules/config/application/config-service";
import type { ConfigActorContext } from "@/modules/config/application/config-access";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture(count = 1) {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Configuration pagination acceptance", baseCurrency: "MAD" } });
  return withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Scoped configuration reader" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const properties = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), organizationId: org, name: `Property ${String(index).padStart(4, "0")}`,
      addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] }));
    await tx.property.createMany({ data: properties });
    const rules = properties.map((property, index) => ({ id: randomUUID(), organizationId: org, key: `feature_flag.page_${String(index).padStart(4, "0")}`,
      scopeType: "property", scopeId: property.id, value: { enabled: true }, version: 1, lifecycle: "ACTIVE", effectiveFrom: new Date("2020-01-01"),
      createdBy: account.id, reason: "Explicit isolated pagination fixture" }));
    await tx.configRule.createMany({ data: rules });
    const ctx: ConfigActorContext = { organizationId: org, actorId: account.id, personId: person.id, authContext: { organizationId: org,
      userAccountId: account.id, personId: person.id, permissions: new Set(["config_rule:view", "config_rule:create", "config_rule:configure"]), scopes: [{ organizationId: org }] } };
    return { org, person, account, properties, rules, ctx };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const model = (f: Fixture, input: Parameters<typeof getConfigAdminModel>[1] = {}, ctx = f.ctx) => getConfigAdminModel(ctx, input, { db });
const scoped = (f: Fixture, propertyId: string) => ({ ...f.ctx, authContext: { ...f.ctx.authContext, scopes: [{ organizationId: f.org, scopeType: "property" as const, scopeId: propertyId }] } });

describe("authorized configuration pages on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url) return; if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Isolated local PostgreSQL required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "ignore" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scopedUrl = new URL(url); scopedUrl.username = scopedUrl.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scopedUrl.toString() });
    expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it.skipIf(!url)("reaches every rule across 501 properties without truncation or duplicate pages", async () => {
    const f = await fixture(501), ids: string[] = []; let after: string | undefined;
    do { const page = await model(f, { after }); expect(page.rules.length).toBeLessThanOrEqual(configAdminPageSize); ids.push(...page.rules.map(rule => rule.id)); after = page.pagination.next ?? undefined; } while (after);
    expect(ids).toEqual(f.rules.map(rule => rule.id)); expect(new Set(ids).size).toBe(501);
  });
  it.skipIf(!url)("checks scope before filling pages even when 500 denied rules precede the permitted record", async () => {
    const f = await fixture(501), reader = scoped(f, f.properties[500].id), page = await model(f, {}, reader);
    expect(page.rules.map(rule => rule.id)).toEqual([f.rules[500].id]); expect(page.properties.map(property => property.id)).toEqual([f.properties[500].id]);
    expect(page.pagination).toEqual({ next: null, previous: null }); expect(JSON.stringify(page)).not.toContain(f.properties[0].name);
  });
  it.skipIf(!url)("moves backward to the exact preceding page with stable rule ordering", async () => {
    const f = await fixture(120), first = await model(f), second = await model(f, { after: first.pagination.next! });
    expect(second.rules.map(rule => rule.id)).toEqual(f.rules.slice(50, 100).map(rule => rule.id));
    const back = await model(f, { before: second.pagination.previous! }); expect(back.rules.map(rule => rule.id)).toEqual(first.rules.map(rule => rule.id));
    expect(back.pagination.previous).toBeNull(); expect(back.pagination.next).toBe(first.pagination.next);
  });
  it.skipIf(!url)("rejects malformed, foreign, out-of-scope and mismatched-filter cursors", async () => {
    const f = await fixture(2), foreign = await fixture();
    for (const input of [{ after: "invalid" }, { after: f.rules[0].id, before: f.rules[1].id }, { after: foreign.rules[0].id },
      { after: f.rules[0].id, ruleKey: f.rules[1].key }, { ruleScopeType: "organization", ruleScopeId: f.properties[0].id }])
      await expect(model(f, input)).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(model(f, { after: f.rules[0].id }, scoped(f, f.properties[1].id))).rejects.toBeInstanceOf(ConfigValidationError);
    expect(await withTenant(db, f.org, tx => tx.configRule.count({ where: { organizationId: foreign.org } }))).toBe(0);
  });
  it.skipIf(!url)("resolves exact preceding versions beyond the visible page for immutable diffs", async () => {
    const f = await fixture(); await withTenant(db, f.org, tx => tx.configRule.createMany({ data: Array.from({ length: 60 }, (_, index) => ({ organizationId: f.org,
      key: "feature_flag.history", scopeType: "organization", value: { enabled: true }, version: index + 1, lifecycle: "ACTIVE",
      effectiveFrom: new Date(Date.UTC(2020, 0, index + 1)), reason: "Immutable history spanning pages", createdBy: f.account.id })) }));
    const first = await model(f, { ruleKey: "feature_flag.history" }); expect(first.rules).toHaveLength(50);
    expect(first.rules.at(-1)?.version).toBe(11); expect(first.rules.every(rule => rule.changedPaths.length === 0)).toBe(true);
    const second = await model(f, { ruleKey: "feature_flag.history", after: first.pagination.next! }); expect(second.rules.at(-1)?.version).toBe(1);
    expect(second.rules.filter(rule => rule.version > 1).every(rule => rule.changedPaths.length === 0)).toBe(true);
  });
  it.skipIf(!url)("keeps compensation and price values hidden without their current separately scoped permissions", async () => {
    const f = await fixture(); await withTenant(db, f.org, tx => tx.configRule.createMany({ data: ["staff.compensation", "services.pricing"].map(key => ({ organizationId: f.org,
      key, scopeType: "property", scopeId: f.properties[0].id, value: { amount: "800.00" }, version: 1, lifecycle: "ACTIVE", effectiveFrom: new Date("2020-01-01"), reason: "Private financial fixture" })) }));
    const hidden = await model(f); expect(hidden.rules).toHaveLength(1); expect(JSON.stringify(hidden)).not.toContain("800.00");
    const wrong = { ...f.ctx, authContext: { ...f.ctx.authContext,
      permissions: new Set([...f.ctx.authContext.permissions, "staff_compensation:view", "financial_transaction:view"]), assignments: [
      { scope: { organizationId: f.org }, permissions: f.ctx.authContext.permissions },
      { scope: { organizationId: f.org, scopeType: "property" as const, scopeId: randomUUID() }, permissions: new Set(["staff_compensation:view", "financial_transaction:view"]) }
    ] } };
    expect(JSON.stringify(await model(f, {}, wrong))).not.toContain("800.00");
    const allowed = { ...wrong, authContext: { ...wrong.authContext, assignments: [wrong.authContext.assignments[0],
      { scope: { organizationId: f.org, scopeType: "property" as const, scopeId: f.properties[0].id }, permissions: new Set(["staff_compensation:view", "financial_transaction:view"]) }] } };
    expect(JSON.stringify(await model(f, {}, allowed))).toContain("800.00");
  });
  it.skipIf(!url)("filters one property/key exactly and rechecks revoked and mismatched actor contexts", async () => {
    const f = await fixture(3), result = await model(f, { ruleKey: f.rules[1].key, ruleScopeType: "property", ruleScopeId: f.properties[1].id });
    expect(result.rules.map(rule => rule.id)).toEqual([f.rules[1].id]);
    expect(result.catalogKeys).toContain(f.rules[1].key);
    await expect(model(f, {}, { ...f.ctx, actorId: randomUUID() })).rejects.toBeInstanceOf(ConfigAuthorizationError);
    await expect(model(f, {}, { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set() } })).rejects.toBeInstanceOf(ConfigAuthorizationError);
  });
  it.skipIf(!url)("batches page history and property metadata without queries per displayed rule", async () => {
    const f = await fixture(501), scopedUrl = new URL(url!); scopedUrl.username = scopedUrl.password = "alvillas_ops_tests";
    const measured = new PrismaClient({ datasourceUrl: scopedUrl.toString(), log: [{ emit: "event", level: "query" }] }); let queries = 0;
    measured.$on("query", () => { queries += 1; });
    try { const page = await getConfigAdminModel(f.ctx, {}, { db: measured }); expect(page.rules).toHaveLength(50); expect(queries).toBeLessThanOrEqual(12); }
    finally { await measured.$disconnect(); }
  });
});
