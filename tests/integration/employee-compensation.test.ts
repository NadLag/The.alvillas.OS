import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { type Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { assignTeamRole, saveTeamCompensation } from "@/modules/identity/application/team-service";
import { previewEmployeeCompensation, EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "@/modules/finance/application/employee-compensation-service";
import { EmployeeCompensationRepository } from "@/modules/finance/infrastructure/employee-compensation-repository";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;

async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Employee compensation source verification", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const source = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Compensation administrator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const staff = await tx.person.create({ data: { organizationId: org, displayName: "Private staff member" } });
    const staffAccount = await tx.userAccount.create({ data: { organizationId: org, personId: staff.id } });
    const region = await tx.region.create({ data: { organizationId: org, name: "Contract region" } });
    const city = await tx.city.create({ data: { organizationId: org, regionId: region.id, name: "Contract city" } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Contract property", addressLine1: "Private address", city: city.name,
      cityId: city.id, regionId: region.id, propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
    const role = await tx.role.create({ data: { organizationId: org, key: "contracted_pool_work", name: "Contracted pool work" } });
    return { person, account, staff, staffAccount, region, city, property, role };
  });
  const base = { org, ...source };
  const writer = await reader(base, { permissions: ["staff_compensation:view", "staff_compensation:create", "role:assign"] });
  const ctx = { ...writer.ctx, personId: source.person.id };
  const assignment = await assignTeamRole(ctx, { personId: source.staff.id, roleId: source.role.id, scopeType: "property", scopeId: source.property.id,
    validFrom: "2020-01-01", validTo: "2040-01-01", assignedToMe: false, reason: "Actual role assignment compensation source" }, { db });
  return { ...base, ctx, assignment };
}
type ReaderFixture = { org: string; person: { id: string }; account: { id: string } };
async function reader(f: ReaderFixture, options: { permissions?: string[]; scopeType?: string; scopeId?: string; conditions?: Prisma.InputJsonObject } = {}) {
  const grant = await withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: options.permissions ?? ["staff_compensation:view"] } } });
    const role = await tx.role.create({ data: { organizationId: f.org, key: "compensation_reader_" + randomUUID(), name: "Explicit compensation authority",
      rolePermissions: { create: permissions.map(permission => ({ organizationId: f.org, permissionId: permission.id })) } } });
    return tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, personId: f.person.id, userAccountId: f.account.id,
      scopeType: options.scopeType ?? "organization", scopeId: options.scopeId, conditions: options.conditions, validFrom: new Date("2019-01-01") } });
  });
  return { grant, ctx: { organizationId: f.org, actorId: f.account.id,
    authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rate(f: Fixture, mode = "PER_JOB", amount = "500.25", expectedVersion = 0, effectiveFrom = "2020-01-01", assignmentId = f.assignment.id) {
  return saveTeamCompensation(f.ctx, { assignmentId, mode, amount, currency: "MAD", expectedVersion, effectiveFrom, reason: "Actual immutable contractual compensation version" }, { db });
}
const input = (f: Fixture, basis: Record<string, string> = { mode: "PER_JOB", jobs: "3" }) => ({ assignmentId: f.assignment.id, earnedAt: "2027-01-15T12:00:00Z", basis });

describe("canonical employee compensation sources on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it.each([
    ["PER_JOB", "500.25", { mode: "PER_JOB", jobs: "3" }, "1500.75"],
    ["PER_HOUR", "500.25", { mode: "PER_HOUR", seconds: "60" }, "8.34"],
    ["PER_MONTH", "3500.25", { mode: "PER_MONTH", numerator: "10", denominator: "31" }, "1129.11"],
    ["PERCENTAGE", "12.34", { mode: "PERCENTAGE", baseAmount: "9999.99" }, "1234.00"]
  ] as const)("calculates %s from actual assignment and configuration versions without accruing money", async (mode, amount, basis, expected) => {
    const f = await fixture(), created = await rate(f, mode, amount);
    const before = await withTenant(db, f.org, async tx => ({ journals: await tx.financialTransaction.count(), postings: await tx.posting.count() }));
    const result = await previewEmployeeCompensation(f.ctx, input(f, basis), { db });
    expect(result).toMatchObject({ kind: "CONTRACTUAL_ESTIMATE", compensationId: created.id, compensationVersion: 1, mode,
      rate: { amount, currency: "MAD" }, amount: { amount: expected, currency: "MAD" } });
    const row = await withTenant(db, f.org, tx => tx.teamCompensation.findUniqueOrThrow({ where: { id: created.id } }));
    expect(result.configRuleId).toBe(row.configRuleId);
    expect(JSON.stringify(result)).not.toMatch(/Private address|Private staff member|requestFingerprint|permissions|authContext/u);
    expect(await withTenant(db, f.org, async tx => ({ journals: await tx.financialTransaction.count(), postings: await tx.posting.count() }))).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { action: "team.compensation.preview", resourceId: created.id } }))).toHaveLength(1);
  });
  it("keeps different assignment rates for one person and selects the effective historical version", async () => {
    const f = await fixture(), first = await rate(f);
    await rate(f, "PER_JOB", "600.50", 1, "2028-01-01");
    const second = await assignTeamRole(f.ctx, { personId: f.staff.id, roleId: f.role.id, scopeType: "city", scopeId: f.city.id,
      validFrom: "2020-01-01", validTo: null, assignedToMe: false, reason: "Independent city landscaping assignment" }, { db });
    await rate(f, "PER_MONTH", "600.00", 0, "2020-01-01", second.id);
    expect(await previewEmployeeCompensation(f.ctx, input(f), { db })).toMatchObject({ compensationId: first.id, amount: { amount: "1500.75" } });
    expect(await previewEmployeeCompensation(f.ctx, { ...input(f, { mode: "PER_MONTH", numerator: "1", denominator: "1" }), assignmentId: second.id }, { db })).toMatchObject({ amount: { amount: "600.00" } });
    expect(await previewEmployeeCompensation(f.ctx, { ...input(f), earnedAt: "2028-01-01T01:00:00+01:00" }, { db })).toMatchObject({ compensationVersion: 2, amount: { amount: "1801.50" } });
  });
  it("denies operational and foreign-tenant callers without revealing contractual rates", async () => {
    const f = await fixture(); await rate(f); const foreign = await fixture();
    const staff = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { permissions: ["task:view", "property:view"] });
    await expect(previewEmployeeCompensation(staff.ctx, input(f), { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
    await expect(previewEmployeeCompensation(foreign.ctx, input(f), { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
  });
  it("requires both the contractual rate and the estimated total to fit a stored amount limit", async () => {
    const f = await fixture(); await rate(f);
    const capped = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { conditions: { maxAmount: "500.25" } });
    await expect(previewEmployeeCompensation(capped.ctx, input(f), { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
    expect(await previewEmployeeCompensation(capped.ctx, input(f, { mode: "PER_JOB", jobs: "1" }), { db })).toMatchObject({ amount: { amount: "500.25" } });
  });
  it("honors a person's own assignment condition without granting access to another person's salary", async () => {
    const f = await fixture(); await rate(f);
    const own = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { conditions: { assignedToMe: true } });
    expect(await previewEmployeeCompensation(own.ctx, input(f), { db })).toMatchObject({ personId: f.staff.id });
    const unrelated = await withTenant(db, f.org, tx => tx.person.create({ data: { organizationId: f.org, displayName: "Different salary beneficiary" } }));
    const assignment = await assignTeamRole(f.ctx, { personId: unrelated.id, roleId: f.role.id, scopeType: "property", scopeId: f.property.id,
      validFrom: "2020-01-01", validTo: null, assignedToMe: false, reason: "Another person's distinct compensation" }, { db });
    await rate(f, "PER_JOB", "700.25", 0, "2020-01-01", assignment.id);
    await expect(previewEmployeeCompensation(own.ctx, { ...input(f), assignmentId: assignment.id }, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
  });
  it("allows a conditional own-person grant for organization-scoped salary without substituting a property grant", async () => {
    const f = await fixture();
    const assignment = await assignTeamRole(f.ctx, { personId: f.staff.id, roleId: f.role.id, scopeType: "organization", scopeId: null,
      validFrom: "2020-01-01", validTo: null, assignedToMe: false, reason: "Organization-scoped personal salary contract" }, { db });
    await rate(f, "PER_MONTH", "500.25", 0, "2020-01-01", assignment.id);
    const own = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { conditions: { assignedToMe: true, maxAmount: "500.25" } });
    const request = { ...input(f, { mode: "PER_MONTH", numerator: "1", denominator: "1" }), assignmentId: assignment.id };
    expect(await previewEmployeeCompensation(own.ctx, request, { db })).toMatchObject({ amount: { amount: "500.25" }, personId: f.staff.id });
    const other = await withTenant(db, f.org, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Property-only operator" } });
      const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } });
      return { org: f.org, person, account };
    });
    const propertyReader = await reader(other, { scopeType: "property", scopeId: f.property.id });
    await expect(previewEmployeeCompensation(propertyReader.ctx, request, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
  });
  it("rejects dates outside the actual assignment while retaining historical contracts after retirement", async () => {
    const f = await fixture(); await rate(f);
    await expect(previewEmployeeCompensation(f.ctx, { ...input(f), earnedAt: "2040-01-01T00:00:00Z" }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date("2028-01-01") } }));
    expect(await previewEmployeeCompensation(f.ctx, input(f), { db })).toMatchObject({ compensationVersion: 1 });
    await expect(previewEmployeeCompensation(f.ctx, { ...input(f), earnedAt: "2028-01-01T00:00:00Z" }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
  });
  it.each(["grant", "city", "new_rate"] as const)("rejects a %s change after reading the actual configuration source", async change => {
    const f = await fixture(); await rate(f);
    const limited = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { scopeType: "city", scopeId: f.city.id });
    const original = Reflect.get<ConfigRuleRepository, "resolve">(ConfigRuleRepository.prototype, "resolve"); let changed = false;
    const spy = vi.spyOn(ConfigRuleRepository.prototype, "resolve").mockImplementation(async function (this: ConfigRuleRepository, ...args) {
      const rule = await original.apply(this, args);
      if (!changed && args[0].key === "staff.compensation") {
        changed = true;
        if (change === "grant") await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: limited.grant.id }, data: { validTo: new Date("2020-01-01") } }));
        else if (change === "city") await withTenant(db, f.org, async tx => {
          const city = await tx.city.create({ data: { organizationId: f.org, regionId: f.region.id, name: "Outside the authorized city" } });
          await tx.property.update({ where: { id: f.property.id }, data: { cityId: city.id } });
        });
        else await rate(f, "PER_JOB", "600.50", 1, "2021-01-01");
      }
      return rule;
    });
    try { await expect(previewEmployeeCompensation(limited.ctx, input(f), { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError); expect(changed).toBe(true); }
    finally { spy.mockRestore(); }
  });
  it("rejects a configuration version that lacks its matching immutable compensation source", async () => {
    const f = await fixture(); await rate(f);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "staff.compensation", scopeType: "role_assignment", scopeId: f.assignment.id,
      value: { compensation_type: "PER_TASK", mode: "PER_JOB", amount: "900.00", currency: "MAD" }, effectiveFrom: new Date("2021-01-01"), reason: "Actual unbound configuration must not become wages" }));
    await expect(previewEmployeeCompensation(f.ctx, input(f), { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
  });
  it.each(["grant", "configuration"] as const)("rolls back the private read audit after a final %s change", async change => {
    const f = await fixture(); await rate(f);
    const limited = await reader({ org: f.org, person: f.staff, account: f.staffAccount });
    const original = Reflect.get<EmployeeCompensationRepository, "source">(EmployeeCompensationRepository.prototype, "source"); let reads = 0, changed = false;
    const spy = vi.spyOn(EmployeeCompensationRepository.prototype, "source").mockImplementation(async function (this: EmployeeCompensationRepository, ...args) {
      const source = await original.apply(this, args);
      if (++reads === 3) {
        if (change === "grant") await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: limited.grant.id }, data: { validTo: new Date("2020-01-01") } }));
        else await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "staff.compensation", scopeType: "role_assignment", scopeId: f.assignment.id,
          value: { compensation_type: "PER_TASK", mode: "PER_JOB", amount: "900.00", currency: "MAD" }, effectiveFrom: new Date("2021-01-01"), reason: "Concurrent unbound configuration must invalidate the estimate" }));
        changed = true;
      }
      return source;
    });
    try {
      await expect(previewEmployeeCompensation(limited.ctx, input(f), { db })).rejects.toBeInstanceOf(change === "grant" ? EmployeeCompensationAccessError : EmployeeCompensationSourceUnavailableError);
      expect(changed).toBe(true);
      expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "team.compensation.preview" } }))).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("keeps one assignment estimate scoped when its person has assignments across 500 properties", async () => {
    const f = await fixture(); await rate(f);
    if (!url) throw Error("Local database required");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    const observed = new PrismaClient({ datasourceUrl: scoped.toString(), log: [{ emit: "event", level: "query" }] });
    let queries = 0; observed.$on("query", () => { queries++; });
    const measure = async () => {
      const before = queries, start = performance.now(), result = await previewEmployeeCompensation(f.ctx, input(f), { db: observed });
      await observed.$queryRaw`SELECT 1`;
      return { result, queries: queries - before, milliseconds: performance.now() - start };
    };
    try {
      const before = await measure();
      await withTenant(db, f.org, async tx => {
        const properties = Array.from({ length: 499 }, (_, index) => ({ id: randomUUID(), organizationId: f.org, name: `Contract capacity property ${index}`,
          addressLine1: "Capacity fixture address", city: f.city.name, cityId: f.city.id, regionId: f.region.id, propertyType: "VILLA", bedrooms: 1, bathrooms: 1,
          maxGuests: 2, amenities: [], photoUrls: [] }));
        await tx.property.createMany({ data: properties });
        await tx.roleAssignment.createMany({ data: properties.map(property => ({ organizationId: f.org, personId: f.staff.id, roleId: f.role.id,
          scopeType: "property", scopeId: property.id, validFrom: new Date("2020-01-01") })) });
        expect(await tx.property.count({ where: { organizationId: f.org } })).toBe(500);
      });
      const after = await measure();
      expect(after.result).toEqual(before.result);
      expect(after.queries).toBe(before.queries);
    } finally { await observed.$disconnect(); }
  });
});
