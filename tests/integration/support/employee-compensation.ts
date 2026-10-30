import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { withTenant, type TenantTransaction, type TenantTransactionOptions, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { assignTeamRole, saveTeamCompensation } from "@/modules/identity/application/team-service";
import { createOperationTask, proxyCompleteOperationTask } from "@/modules/reservations/application/operation-service";
import { assignOperationTask } from "@/modules/reservations/application/operation-scheduling";
import { completeAssignedFieldTask, completeAssignedFieldTaskInTransaction } from "@/modules/reservations/application/reservation-service";
import operatingPolicy from "@/platform/config/defaults/operations.json";

export function employeeCompensationFixtures(getDb: () => TenantTransactionRunner, getAdmin: () => Pick<PrismaClient, "organization">) {
  const db: TenantTransactionRunner = { $transaction: <T>(work: (tx: TenantTransaction) => Promise<T>, options?: TenantTransactionOptions) => getDb().$transaction(work, options) };
async function fixture() {
  const org = randomUUID();
  await getAdmin().organization.create({ data: { id: org, name: "Employee compensation source verification", baseCurrency: "MAD" } });
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

async function completedFixture(method: "SELF" | "OFFLINE_SYNC" | "PROXY", noLogin = false) {
  const f = await fixture();
  const operations = await reader(f, { permissions: ["task:view", "task:create", "task:edit", "task:assign", "task:validate"] });
  const ctx = { ...operations.ctx, personId: f.person.id };
  await withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["task:view", "task:edit"] } } });
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })) });
    const policy = structuredClone(operatingPolicy); policy.types.INSPECTION.role_keys = [f.role.key];
    await new ConfigRuleRepository(tx, f.org).createVersion({ key: "ops.task_policy", scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      value: policy, reason: "Actual configured compensation task routing" });
    await new ConfigRuleRepository(tx, f.org).createVersion({ key: "ops.checklists", scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      value: { checklists: [{ key: "compensation_work", name: { en: "Completed contracted work", fr: "Travail contractuel terminé" },
        items: [{ key: "completed", label: { en: "Confirm contracted work", fr: "Confirmer le travail contractuel" } }] }] }, reason: "Actual completed-work checklist evidence" });
  });
  const performer = noLogin ? await withTenant(db, f.org, tx => tx.person.create({ data: { organizationId: f.org, displayName: "Performer without login" } })) : f.staff;
  const contract = noLogin ? await assignTeamRole(ctx, { personId: performer.id, roleId: f.role.id, scopeType: "property", scopeId: f.property.id,
    userAccountId: null, validFrom: "2020-01-01", validTo: null, assignedToMe: false, reason: "Actual contract for person-only completed work" }, { db }) : f.assignment;
  await saveTeamCompensation(ctx, { assignmentId: contract.id, expectedVersion: 0, mode: "PER_JOB", amount: "500.25", currency: "MAD", effectiveFrom: "2020-01-01",
    reason: "Actual configured per-job compensation" }, { db });
  const taskId = await completeTask({ ...f, ctx }, method, performer);
  return { ...f, ctx, performer, contract, taskId };
}

async function completeTask(f: Fixture, method: "SELF" | "OFFLINE_SYNC" | "PROXY" = "SELF", performer = f.staff) {
  const ctx = f.ctx;
  const created = await createOperationTask(ctx, { propertyId: f.property.id, type: "INSPECTION", title: { en: "Perform contracted work", fr: "Réaliser le travail contractuel" },
    dueDate: "2027-04-10", priority: "NORMAL", checklistTemplateKey: "compensation_work", idempotencyKey: randomUUID(), reason: "Actual completed-work source creation" }, { db, requestId: randomUUID() });
  const assigned = await assignOperationTask(ctx, { taskId: created.id, expectedVersion: created.version, personId: performer.id,
    startMinute: 600, idempotencyKey: randomUUID(), reason: "Actual performer assignment before completion" }, { db, requestId: randomUUID() });
  const checklistItemIds = assigned.checklistItems.map(item => item.id), requestId = randomUUID();
  if (method === "PROXY") await proxyCompleteOperationTask(ctx, { taskId: assigned.id, expectedVersion: assigned.version, performedByPersonId: performer.id,
    checklistItemIds, idempotencyKey: randomUUID(), reason: "Validate the colleague's work while they are offline" }, { db, requestId });
  else {
    const worker = { organizationId: f.org, actorId: f.staffAccount.id, personId: f.staff.id,
      authContext: { ...await authContextForAccount(f.org, f.staffAccount.id, { db }), personId: f.staff.id } };
    const command = { taskId: assigned.id, checklistItemIds, idempotencyKey: randomUUID(), note: "Actual performed contracted work" };
    if (method === "SELF") await completeAssignedFieldTask(worker, command, { db, requestId });
    else await withTenant(db, f.org, tx => completeAssignedFieldTaskInTransaction(worker, command, tx,
      { requestId, ipAddress: null }, "OFFLINE_SYNC"));
  }
  return assigned.id;
}

  return { fixture, reader, rate, input, completedFixture, completeTask };
}
