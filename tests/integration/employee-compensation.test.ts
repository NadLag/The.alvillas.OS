import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { employeeCompensationFixtures } from "./support/employee-compensation";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { assignTeamRole, saveTeamCompensation } from "@/modules/identity/application/team-service";
import { previewEmployeeCompensation, EmployeeCompensationAccessError, EmployeeCompensationSourceUnavailableError } from "@/modules/finance/application/employee-compensation-service";
import { EmployeeCompensationRepository } from "@/modules/finance/infrastructure/employee-compensation-repository";
import { previewEmployeeCompletedWork } from "@/modules/finance/application/employee-completed-work-service";
import { createOperationTask } from "@/modules/reservations/application/operation-service";
import { assignOperationTask } from "@/modules/reservations/application/operation-scheduling";
import { completeAssignedFieldTask } from "@/modules/reservations/application/reservation-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;

const { fixture, reader, rate, input, completedFixture } = employeeCompensationFixtures(() => db, () => admin);

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
  it.each(["SELF", "OFFLINE_SYNC", "PROXY"] as const)("binds %s completed work to its actual performer and immutable event", async method => {
    const f = await completedFixture(method), requestId = randomUUID();
    const result = await previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db, requestId });
    expect(result).toMatchObject({ kind: "COMPLETED_JOB_ESTIMATE", taskId: f.taskId, performedByPersonId: f.performer.id, completionMethod: method,
      basis: { mode: "PER_JOB", jobs: "1" }, amount: { amount: "500.25", currency: "MAD" } });
    expect(result.performedByPersonId).not.toBe(f.person.id);
    const event = await withTenant(db, f.org, tx => tx.operationTaskEvent.findUniqueOrThrow({ where: { id: result.completionEventId } }));
    expect(event).toMatchObject({ taskId: f.taskId, version: result.completionVersion });
    const audits = await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { requestId }, orderBy: { id: "asc" } }));
    expect(audits.map(row => row.action).sort()).toEqual(["team.compensation.completed_work.preview", "team.compensation.preview"]);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("preserves a person-only proxy performer without requiring a worker login", async () => {
    const f = await completedFixture("PROXY", true);
    expect(await previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).toMatchObject({
      performedByPersonId: f.performer.id, completionMethod: "PROXY", amount: { amount: "500.25" } });
  });
  it("rejects the proxy validator's contract and an unconfirmed assignment", async () => {
    const f = await completedFixture("PROXY");
    const validatorContract = await withTenant(db, f.org, tx => tx.roleAssignment.findFirstOrThrow({ where: { organizationId: f.org, personId: f.person.id, scopeType: "organization" } }));
    await saveTeamCompensation(f.ctx, { assignmentId: validatorContract.id, expectedVersion: 0, mode: "PER_JOB", amount: "700.25", currency: "MAD",
      effectiveFrom: "2020-01-01", reason: "Validator contract is not the performer's contract" }, { db });
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: validatorContract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: false }, { db })).rejects.toThrow();
  });
  it("rejects a seeded completed state without its actual immutable completion event", async () => {
    const f = await completedFixture("SELF");
    const seeded = await withTenant(db, f.org, tx => tx.operationTask.create({ data: { organizationId: f.org, propertyId: f.property.id, type: "INSPECTION", state: "COMPLETED",
      dueDate: new Date("2027-04-10"), titleTranslations: { en: "Unverified state", fr: "État non vérifié" }, idempotencyKey: randomUUID(),
      completedAt: new Date(), completedByPersonId: f.staff.id, completedByUserAccountId: f.staffAccount.id, completionSource: "SELF", completionIdempotencyKey: randomUUID() } }));
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: seeded.id, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
  });
  it("requires the actual completed checklist to retain the performer attribution", async () => {
    const f = await completedFixture("SELF");
    await withTenant(db, f.org, tx => tx.operationTaskChecklistItem.updateMany({ where: { organizationId: f.org, taskId: f.taskId },
      data: { completedAt: null, completedByPersonId: null, completedByUserAccountId: null } }));
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
  });
  it("requires the contract's role to match the role recorded for the performed job", async () => {
    const f = await completedFixture("SELF");
    const role = await withTenant(db, f.org, tx => tx.role.create({ data: { organizationId: f.org, key: "different_contracted_work", name: "A different contracted role" } }));
    const assignment = await assignTeamRole(f.ctx, { personId: f.staff.id, roleId: role.id, scopeType: "property", scopeId: f.property.id,
      validFrom: "2020-01-01", validTo: null, assignedToMe: false, reason: "Independent role cannot consume another role's job" }, { db });
    await saveTeamCompensation(f.ctx, { assignmentId: assignment.id, expectedVersion: 0, mode: "PER_JOB", amount: "800.25", currency: "MAD",
      effectiveFrom: "2020-01-01", reason: "Actual distinct contractual source" }, { db });
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: assignment.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
  });
  it("rejects a job outside the contract's actual property and a non-job rate", async () => {
    const f = await completedFixture("SELF");
    const property = await withTenant(db, f.org, tx => tx.property.create({ data: { organizationId: f.org, name: "Different contract property", addressLine1: "Private other address",
      city: f.city.name, cityId: f.city.id, regionId: f.region.id, propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } }));
    const contract = await assignTeamRole(f.ctx, { personId: f.staff.id, roleId: f.role.id, scopeType: "property", scopeId: property.id,
      validFrom: "2020-01-01", validTo: null, assignedToMe: false, reason: "Different property has its own independent rate" }, { db });
    await saveTeamCompensation(f.ctx, { assignmentId: contract.id, expectedVersion: 0, mode: "PER_JOB", amount: "900.25", currency: "MAD", effectiveFrom: "2020-01-01",
      reason: "Actual other property rate" }, { db });
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
    await saveTeamCompensation(f.ctx, { assignmentId: f.contract.id, expectedVersion: 1, mode: "PER_HOUR", amount: "50.25", currency: "MAD", effectiveFrom: "2021-01-01",
      reason: "Hourly work requires its quantified work evidence" }, { db });
    await expect(previewEmployeeCompletedWork(f.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationSourceUnavailableError);
  });
  it("uses recorded completion time instead of the planned due date for the caller's time limit", async () => {
    const f = await completedFixture("SELF");
    const limited = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { conditions: { timeWindow: { startsAt: "2027-01-01", endsAt: "2027-12-31" } } });
    await expect(previewEmployeeCompletedWork(limited.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
    const foreign = await fixture();
    await expect(previewEmployeeCompletedWork(foreign.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
  });
  it("honors an explicit single-job financial grant without exposing other jobs or the full contract estimate", async () => {
    const f = await completedFixture("SELF");
    const limited = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { scopeType: "job", scopeId: f.taskId });
    expect(await previewEmployeeCompletedWork(limited.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).toMatchObject({
      taskId: f.taskId, amount: { amount: "500.25" } });
    await expect(previewEmployeeCompensation(limited.ctx, { assignmentId: f.contract.id, earnedAt: new Date().toISOString(), basis: { mode: "PER_JOB", jobs: "1" } }, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
    const created = await createOperationTask(f.ctx, { propertyId: f.property.id, type: "INSPECTION", title: { en: "A different job", fr: "Un autre travail" },
      dueDate: "2027-04-11", priority: "NORMAL", checklistTemplateKey: "compensation_work", idempotencyKey: randomUUID(), reason: "Actual separate job in the same tenant" }, { db, requestId: randomUUID() });
    const other = await assignOperationTask(f.ctx, { taskId: created.id, expectedVersion: created.version, personId: f.staff.id,
      startMinute: 600, idempotencyKey: randomUUID(), reason: "Actual separate assignment for the same performer" }, { db, requestId: randomUUID() });
    const worker = { organizationId: f.org, actorId: f.staffAccount.id, personId: f.staff.id,
      authContext: { ...await authContextForAccount(f.org, f.staffAccount.id, { db }), personId: f.staff.id } };
    await completeAssignedFieldTask(worker, { taskId: other.id, checklistItemIds: other.checklistItems.map(item => item.id),
      idempotencyKey: randomUUID(), note: "Complete the independent second job" }, { db, requestId: randomUUID() });
    await expect(previewEmployeeCompletedWork(limited.ctx, { taskId: other.id, assignmentId: f.contract.id, confirmedAssignment: true }, { db })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
  });
  it("rolls back both source read audits when the actual grant expires after all source reads", async () => {
    const f = await completedFixture("PROXY"), limited = await reader({ org: f.org, person: f.staff, account: f.staffAccount }), requestId = randomUUID();
    const original = Reflect.get<EmployeeCompensationRepository, "source">(EmployeeCompensationRepository.prototype, "source"); let reads = 0, expired = false;
    const spy = vi.spyOn(EmployeeCompensationRepository.prototype, "source").mockImplementation(async function (this: EmployeeCompensationRepository, ...args) {
      const source = await original.apply(this, args);
      if (++reads === 5) {
        await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: limited.grant.id }, data: { validTo: new Date("2020-01-01") } }));
        expired = true;
      }
      return source;
    });
    try {
      await expect(previewEmployeeCompletedWork(limited.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db, requestId })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
      expect(expired).toBe(true);
      expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { requestId } }))).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("rejects a property scope change inside the contractual estimate and rolls back the complete job read", async () => {
    const f = await completedFixture("PROXY"), limited = await reader({ org: f.org, person: f.staff, account: f.staffAccount }, { scopeType: "city", scopeId: f.city.id }), requestId = randomUUID();
    const original = Reflect.get<ConfigRuleRepository, "resolve">(ConfigRuleRepository.prototype, "resolve"); let reads = 0, changed = false;
    const spy = vi.spyOn(ConfigRuleRepository.prototype, "resolve").mockImplementation(async function (this: ConfigRuleRepository, ...args) {
      const rule = await original.apply(this, args);
      if (args[0].key === "staff.compensation" && ++reads === 3) {
        await withTenant(db, f.org, async tx => {
          const city = await tx.city.create({ data: { organizationId: f.org, regionId: f.region.id, name: "Different actual work scope" } });
          await tx.property.update({ where: { id: f.property.id }, data: { cityId: city.id } });
        }); changed = true;
      }
      return rule;
    });
    try {
      await expect(previewEmployeeCompletedWork(limited.ctx, { taskId: f.taskId, assignmentId: f.contract.id, confirmedAssignment: true }, { db, requestId })).rejects.toBeInstanceOf(EmployeeCompensationAccessError);
      expect(changed).toBe(true);
      expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { requestId } }))).toBe(0);
    } finally { spy.mockRestore(); }
  });
});
