import { provisionIntegrationRole } from "./support/database-role";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { permissionCatalog } from "@/platform/authz/catalog";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { createOperationTask, operationTaskDetail, proxyCompleteOperationTask, transitionOperationTask } from "@/modules/reservations/application/operation-service";
import { completeAssignedFieldTask, ReservationAuthorizationError, ReservationConflictError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { taskTypeSchema } from "@/platform/config/rule-registry";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
function actor(org: string, id: string, personId: string, permissions = new Set(permissionCatalog.map(p => p.key))): ReservationActorContext {
  return { organizationId: org, actorId: id, personId, authContext: { organizationId: org, userAccountId: id, personId, permissions, scopes: [{ organizationId: org }] } };
}
const deps = () => ({ db, requestId: randomUUID() });
async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Operations integration", baseCurrency: "MAD" } });
  const f = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Supervisor" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const worker = await tx.person.create({ data: { organizationId: org, displayName: "Performer" } });
    const workerAccount = await tx.userAccount.create({ data: { organizationId: org, personId: worker.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Operations villa", addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 2, bathrooms: 2, maxGuests: 4, amenities: [], photoUrls: [] } });
    await new ConfigRuleRepository(tx, org).createVersion({ key: "ops.checklists", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), reason: "Configured operational checklists", value: { checklists: [{ key: "inspection", name: { en: "Inspection", fr: "Inspection" }, items: [{ key: "ready", label: { en: "Confirm readiness", fr: "Confirmer la préparation" } }] }] } });
    return { person, account, worker, workerAccount, property };
  });
  return { ...f, org, ctx: actor(org, f.account.id, f.person.id), workerCtx: actor(org, f.workerAccount.id, f.worker.id, new Set(["task:view", "task:edit"])) };
}
function input(f: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  return { propertyId: f.property.id, type: "INSPECTION", title: { en: "Inspect villa", fr: "Inspecter la villa" }, dueDate: "2027-04-10", priority: "HIGH", checklistTemplateKey: "inspection", idempotencyKey: randomUUID(), reason: "Prepare the next arrival", ...extra };
}
async function assigned(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await createOperationTask(f.ctx, input(f), deps());
  await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: task.id }, data: { assignedToPersonId: f.worker.id, assignedToUserAccountId: f.workerAccount.id, state: "ASSIGNED" } }));
  return (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task;
}
describe("operations on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local TEST_DATABASE_URL is required for Operations integration");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const app = new URL(url); app.username = "alvillas_ops_tests"; app.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: app.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it("creates every task type idempotently, freezes checklists and maintains append-only version history", async () => {
    const f = await fixture(), value = input(f);
    const results = await Promise.all([createOperationTask(f.ctx, value, deps()), createOperationTask(f.ctx, value, deps())]);
    expect(results[0].id).toBe(results[1].id);
    const task = results[0];
    await expect(createOperationTask(f.ctx, { ...value, priority: "URGENT" }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
    for (const type of taskTypeSchema.options) await createOperationTask(f.ctx, input(f, { type }), deps());
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "ops.checklists", scopeType: "organization", effectiveFrom: new Date("2021-01-01"), reason: "Update the inspection catalog", value: { checklists: [{ key: "inspection", name: { en: "Updated", fr: "Modifié" }, items: [{ key: "new", label: { en: "New step", fr: "Nouvelle étape" } }] }] } }));
    expect((await operationTaskDetail(f.ctx, task.id, undefined, deps())).task.checklistItems[0].key).toBe("ready");
    const command = { taskId: task.id, expectedVersion: task.version, state: "BLOCKED", reason: "Access code unavailable", idempotencyKey: randomUUID() };
    await transitionOperationTask(f.ctx, command, deps()); await transitionOperationTask(f.ctx, command, deps());
    const history = await operationTaskDetail(f.ctx, task.id, undefined, deps());
    expect(history.events.map(e => e.version)).toEqual([2, 1]);
    expect(history.events[0]).toMatchObject({ actorId: f.ctx.actorId, reason: command.reason });
    await expect(withTenant(db, f.org, tx => tx.operationTaskEvent.updateMany({ data: { reason: "changed" } }))).rejects.toThrow(/append-only/);
    await expect(transitionOperationTask(f.ctx, { ...command, state: "CANCELLED", idempotencyKey: randomUUID() }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
  });
  it("enforces tenant, property and command authorization before mutations", async () => {
    const f = await fixture(), other = await fixture(), task = await createOperationTask(f.ctx, input(f), deps());
    await expect(operationTaskDetail(other.ctx, task.id, undefined, deps())).rejects.toBeInstanceOf(ReservationNotFoundError);
    await expect(createOperationTask(other.ctx, input(f), deps())).rejects.toBeInstanceOf(ReservationNotFoundError);
    const denied = actor(f.org, f.ctx.actorId, f.ctx.personId, new Set(["task:view"]));
    await expect(transitionOperationTask(denied, { taskId: task.id, expectedVersion: task.version, state: "CANCELLED", reason: "Unauthorized cancellation", idempotencyKey: randomUUID() }, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    const scoped = { ...f.ctx, authContext: { ...f.ctx.authContext, scopes: [{ organizationId: f.org, scopeType: "property" as const, scopeId: randomUUID() }] } };
    await expect(operationTaskDetail(scoped, task.id, undefined, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    expect(await withTenant(db, other.org, tx => tx.operationTaskEvent.count({ where: { taskId: task.id } }))).toBe(0);
    const roles = await admin.$queryRaw<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='alvillas_ops_tests'`;
    expect(roles[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
  it("requires exact checklists, distinct assigned performer and validator and records proxy identity exactly once", async () => {
    const f = await fixture(), task = await assigned(f);
    const command = { taskId: task.id, expectedVersion: task.version, performedByPersonId: f.worker.id, checklistItemIds: task.checklistItems.map(i => i.id), reason: "Worker has no connection", idempotencyKey: randomUUID() };
    await expect(proxyCompleteOperationTask(f.workerCtx, command, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(proxyCompleteOperationTask(f.ctx, { ...command, performedByPersonId: f.person.id }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
    await expect(proxyCompleteOperationTask(f.ctx, { ...command, checklistItemIds: [randomUUID()] }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
    const completed = await proxyCompleteOperationTask(f.ctx, command, deps());
    expect(completed).toMatchObject({ state: "COMPLETED", completedByPersonId: f.worker.id, completedByUserAccountId: f.workerAccount.id, validatedByPersonId: f.person.id, validatedByUserAccountId: f.account.id, validationReason: command.reason, completionSource: "PROXY" });
    expect(completed.checklistItems.every(i => i.completedByPersonId === f.worker.id)).toBe(true);
    await proxyCompleteOperationTask(f.ctx, command, deps());
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } }))).toBe(1);
    const history = await operationTaskDetail(f.ctx, task.id, undefined, deps());
    expect(history.events.map(e => e.version)).toEqual([4, 3, 2, 1]);
  });
  it("serializes worker completion, blocks cancelled work and records SELF rather than the validator", async () => {
    const f = await fixture(), task = await assigned(f);
    const value = { taskId: task.id, idempotencyKey: randomUUID(), checklistItemIds: task.checklistItems.map(i => i.id) };
    await Promise.all([completeAssignedFieldTask(f.workerCtx, value, deps()), completeAssignedFieldTask(f.workerCtx, value, deps())]);
    const completed = (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task;
    expect(completed).toMatchObject({ completionSource: "SELF", completedByPersonId: f.worker.id, validatedByPersonId: null });
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: task.id, action: "task.complete" } }))).toBe(1);
    const cancelled = await assigned(f);
    await transitionOperationTask(f.ctx, { taskId: cancelled.id, expectedVersion: cancelled.version, state: "CANCELLED", reason: "Guest cancelled the service", idempotencyKey: randomUUID() }, deps());
    await expect(completeAssignedFieldTask(f.workerCtx, { ...value, taskId: cancelled.id, checklistItemIds: cancelled.checklistItems.map(i => i.id), idempotencyKey: randomUUID() }, deps())).rejects.toBeInstanceOf(ReservationConflictError);
  });
});
