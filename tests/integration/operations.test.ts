import { provisionIntegrationRole } from "./support/database-role";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { permissionCatalog } from "@/platform/authz/catalog";
import { fieldProxyTasks } from "@/modules/reservations/application/field-proxy-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import {
  createOperationTask,
  operationTaskDetail,
  operationScope,
  taskResource,
  proxyCompleteOperationTask,
  transitionOperationTask,
} from "@/modules/reservations/application/operation-service";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { authorize } from "@/platform/authz/authorize";
import {
  completeAssignedFieldTask,
  ReservationAuthorizationError,
  ReservationConflictError,
  ReservationNotFoundError,
} from "@/modules/reservations/application/reservation-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { parseSyncPushInput, pushSyncOps } from "@/modules/reservations/application/sync-service";
import { pullFieldWork } from "@/modules/reservations/application/field-pull-service";
import { fieldPullInputSchema } from "@/modules/reservations/domain/field-pull";
import type { SyncPushInput, SyncPushOp } from "@/modules/reservations/domain/sync-protocol";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import defaultPolicy from "@/platform/config/defaults/operations.json";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import {
  operationAssignmentOptions,
  assignOperationTask,
  rescheduleOperationTask,
  swapOperationTasks,
} from "@/modules/reservations/application/operation-scheduling";
import {
  generateRecurringOperations,
  saveOperationSeries,
  operationSeriesOptions,
  operationReadiness,
  scheduleOperationTasks,
} from "@/modules/reservations/application/operation-automation";
import {
  operationManagement,
  bulkOperationTasks,
  saveOperationView,
  archiveOperationView,
} from "@/modules/reservations/application/operation-management";
import {
  attachOperationEvidence,
  downloadOperationEvidence,
  reportOperationIssue,
  saveOperationProgress,
} from "@/modules/reservations/application/operation-evidence";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
function actor(
  org: string,
  id: string,
  personId: string,
  permissions = new Set(permissionCatalog.map((p) => p.key)),
): ReservationActorContext {
  return {
    organizationId: org,
    actorId: id,
    personId,
    authContext: {
      organizationId: org,
      userAccountId: id,
      personId,
      permissions,
      scopes: [{ organizationId: org }],
    },
  };
}
const deps = () => ({ db, requestId: randomUUID() });
async function fixture() {
  const org = randomUUID();
  await admin.organization.create({
    data: { id: org, name: "Operations integration", baseCurrency: "MAD" },
  });
  const f = await withTenant(db, org, async (tx) => {
    const person = await tx.person.create({
      data: { organizationId: org, displayName: "Supervisor" },
    });
    const account = await tx.userAccount.create({
      data: { organizationId: org, personId: person.id },
    });
    const worker = await tx.person.create({
      data: { organizationId: org, displayName: "Performer" },
    });
    const workerAccount = await tx.userAccount.create({
      data: { organizationId: org, personId: worker.id },
    });
    const property = await tx.property.create({
      data: {
        organizationId: org,
        name: "Operations villa",
        addressLine1: "Test",
        city: "Marrakech",
        propertyType: "VILLA",
        bedrooms: 2,
        bathrooms: 2,
        maxGuests: 4,
        amenities: [],
        photoUrls: [],
      },
    });
    await new ConfigRuleRepository(tx, org).createVersion({
      key: "ops.checklists",
      scopeType: "organization",
      effectiveFrom: new Date("2020-01-01"),
      reason: "Configured operational checklists",
      value: {
        checklists: [
          {
            key: "inspection",
            name: { en: "Inspection", fr: "Inspection" },
            items: [
              {
                key: "ready",
                label: {
                  en: "Confirm readiness",
                  fr: "Confirmer la préparation",
                },
              },
            ],
          },
        ],
      },
    });
    return { person, account, worker, workerAccount, property };
  });
  return {
    ...f,
    org,
    ctx: actor(org, f.account.id, f.person.id),
    workerCtx: actor(
      org,
      f.workerAccount.id,
      f.worker.id,
      new Set(["task:view", "task:edit"]),
    ),
  };
}
function input(f: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  return {
    propertyId: f.property.id,
    type: "INSPECTION",
    title: { en: "Inspect villa", fr: "Inspecter la villa" },
    dueDate: "2027-04-10",
    priority: "HIGH",
    checklistTemplateKey: "inspection",
    idempotencyKey: randomUUID(),
    reason: "Prepare the next arrival",
    ...extra,
  };
}
async function assigned(f: Awaited<ReturnType<typeof fixture>>) {
  const task = await createOperationTask(f.ctx, input(f), deps());
  await withTenant(db, f.org, (tx) =>
    tx.operationTask.update({
      where: { id: task.id },
      data: {
        assignedToPersonId: f.worker.id,
        assignedToUserAccountId: f.workerAccount.id,
        state: "ASSIGNED",
      },
    }),
  );
  return (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task;
}

function queued(task: Awaited<ReturnType<typeof assigned>>): Omit<SyncPushInput, "ops"> & { ops: Array<Extract<SyncPushOp, { type: "field_task.complete" }>> } {
  return { organization_id: task.organizationId, actor_user_id: task.assignedToUserAccountId!, device_id: randomUUID(), op_schema_version: 1, ops: [{ client_op_id: randomUUID(), type: "field_task.complete",
    client_created_at: "2001-01-01T00:00:00.000Z", payload: { taskId: task.id, checklistItemIds: task.checklistItems.map(item => item.id), note: "Offline field evidence" } }] };
}
function parsedBatch(input: unknown): SyncPushInput {
  const parsed = parseSyncPushInput(input);
  if (!parsed.success) throw new Error("Expected a valid supervisor sync envelope");
  return parsed.data;
}
function queuedProxy(task: Awaited<ReturnType<typeof assigned>>, ctx: ReservationActorContext): SyncPushInput {
  return parsedBatch({ organization_id: ctx.organizationId, actor_user_id: ctx.actorId, device_id: randomUUID(), op_schema_version: 1,
    ops: [{ client_op_id: randomUUID(), type: "field_task.proxy_validate", client_created_at: "2026-10-24T00:00:00-06:00",
      payload: { taskId: task.id, expectedVersion: task.version, performedByPersonId: task.assignedToPersonId,
        checklistItemIds: task.checklistItems.map(item => item.id), reason: "Review colleague work recorded while offline" } }] });
}
async function crew(f: Awaited<ReturnType<typeof fixture>>) {
  await ensureStandardIdentitySetup(f.org, { db });
  return withTenant(db, f.org, async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { organizationId: f.org, key: "field_staff" },
    });
    const managerRole = await tx.role.findFirstOrThrow({
      where: { organizationId: f.org, key: "operations_manager" },
    });
    await tx.roleAssignment.create({
      data: {
        organizationId: f.org,
        personId: f.person.id,
        userAccountId: f.account.id,
        roleId: managerRole.id,
        scopeType: "organization",
        scopeId: null,
        validFrom: new Date("2020-01-01"),
      },
    });
    const fallback = await tx.person.create({
        data: { organizationId: f.org, displayName: "Fallback operator" },
      }),
      account = await tx.userAccount.create({
        data: { organizationId: f.org, personId: fallback.id },
      });
    for (const [personId, userAccountId] of [
      [f.worker.id, f.workerAccount.id],
      [fallback.id, account.id],
    ])
      await tx.roleAssignment.create({
        data: {
          organizationId: f.org,
          personId,
          userAccountId,
          roleId: role.id,
          scopeType: "property",
          scopeId: f.property.id,
          validFrom: new Date("2020-01-01"),
        },
      });
    const policy = structuredClone(defaultPolicy);
    for (const settings of Object.values(policy.types)) {
      settings.preferred_people.push(f.worker.id as never);
      settings.fallback_people.push(fallback.id as never);
    }
    await new ConfigRuleRepository(tx, f.org).createVersion({
      key: "ops.task_policy",
      scopeType: "organization",
      value: policy,
      effectiveFrom: new Date("2020-01-01"),
      reason: "Explicit preferred and fallback assignment policy",
    });
    return { fallback, account, policy, role };
  });
}
describe("operations on real PostgreSQL", () => {
  it("keeps property, state, own-assignment and individual-job grants separate when grouping query predicates", async () => {
    const f = await fixture();
    await withTenant(db, f.org, async tx => {
      const property = await tx.property.create({ data: { organizationId: f.org, name: "Second scoped query property", addressLine1: "Local scope acceptance", city: "Marrakech",
        propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
      const jobs = [];
      for (const propertyId of [f.property.id, property.id]) for (const state of ["PLANNED", "ASSIGNED", "BLOCKED"] as const) for (const own of [false, true])
        jobs.push({ id: randomUUID(), organizationId: f.org, propertyId, type: "INSPECTION", state, titleTranslations: { en: "Actual scoped query task" },
          dueDate: new Date("2027-04-10"), priority: "NORMAL", idempotencyKey: randomUUID(), assignedToPersonId: own ? f.person.id : f.worker.id,
          assignedToUserAccountId: own ? f.account.id : f.workerAccount.id });
      await tx.operationTask.createMany({ data: jobs });
      const individual = jobs.find(job => job.propertyId === property.id && job.state === "PLANNED" && job.assignedToPersonId === f.worker.id)!;
      const permissions = new Set(["task:view", "task:assign"]), ctx = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions, assignments: [
        { permissions, scope: { organizationId: f.org, scopeType: "property" as const, scopeId: f.property.id }, conditions: { statuses: ["PLANNED"] } },
        { permissions, scope: { organizationId: f.org, scopeType: "organization" as const }, conditions: { assignedToMe: true, statuses: ["ASSIGNED", "BLOCKED"] } },
        { permissions, scope: { organizationId: f.org, scopeType: "property" as const, scopeId: property.id }, conditions: { statuses: ["ASSIGNED"] } },
        { permissions, scope: { organizationId: f.org, scopeType: "job" as const, scopeId: individual.id } }
      ] } };
      const repository = new OperationRepository(tx, f.org), scope = await operationScope(ctx, "assign", repository, await repository.properties());
      const actual = await repository.page({ OR: scope.groups }, 0, 50), all = await repository.scoped(jobs.map(job => job.id));
      const expected = all.filter(job => authorize(ctx.authContext, "assign", taskResource(job))).map(job => job.id).sort();
      expect(actual.map(job => job.id).sort()).toEqual(expected); expect(actual).toHaveLength(8);
      expect(scope.visible).toEqual(new Set([f.property.id, property.id]));
    });
  });
  it("loads authorized assignment options across four thousand properties without exceeding PostgreSQL bind limits", async () => {
    const f = await fixture(); await crew(f);
    await withTenant(db, f.org, async tx => {
      for (let offset = 0; offset < 4000; offset += 500) await tx.property.createMany({ data: Array.from({ length: 500 }, (_, index) => ({
        organizationId: f.org, name: `Actual assignment roster ${offset + index}`, addressLine1: "Local scale acceptance", city: "Marrakech",
        timezone: index % 2 ? "Europe/Paris" : "Asia/Tokyo",
        propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] })) });
    }, { timeout: 120000 });
    const task = await createOperationTask(f.ctx, input(f), deps()), candidate = await createOperationTask(f.ctx, input(f), deps());
    await assignOperationTask(f.ctx, { taskId: candidate.id, expectedVersion: candidate.version, personId: f.worker.id, startMinute: 540,
      reason: "Actual assigned candidate at property scale", idempotencyKey: randomUUID() }, deps());
    const options = await operationAssignmentOptions(f.ctx, task.id, deps());
    expect(options.swapTasks.map(row => row.id)).toEqual([candidate.id]);
    const choices = await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).listPropertyScopeOptions());
    expect(choices).toHaveLength(4001); expect(choices.some(property => property.id === f.property.id)).toBe(true);
    const readiness = await operationReadiness(f.ctx, deps());
    expect(readiness).toHaveLength(4001); expect(new Set(readiness.map(row => row.propertyId)).size).toBe(4001);
    expect(readiness.some(row => row.propertyId === f.property.id)).toBe(true);
  });
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
      throw new Error(
        "Local TEST_DATABASE_URL is required for Operations integration",
      );
    execFileSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
    admin = new PrismaClient({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const app = new URL(url);
    app.username = "alvillas_ops_tests";
    app.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: app.toString() });
  });
  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$disconnect();
  });
  it("applies one queued proxy validation across concurrent retries with separate attribution", async () => {
    const f = await fixture(), task = await assigned(f), batch = queuedProxy(task, f.ctx);
    const results = await Promise.all(Array.from({ length: 6 }, () => pushSyncOps(f.ctx, batch, deps())));
    expect(results.flatMap(result => result.results).filter(result => result.status === "APPLIED")).toHaveLength(1);
    expect(results.flatMap(result => result.results).filter(result => result.status === "DUPLICATE")).toHaveLength(5);
    await withTenant(db, f.org, async tx => {
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ state: "COMPLETED", completionSource: "PROXY",
        completedByPersonId: f.worker.id, completedByUserAccountId: f.workerAccount.id, validatedByPersonId: f.person.id, validatedByUserAccountId: f.account.id,
        completionIdempotencyKey: batch.ops[0].client_op_id });
      expect(await tx.syncOp.count({ where: { clientOpId: batch.ops[0].client_op_id, status: "APPLIED" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "ProxyValidated", payload: { path: ["taskId"], equals: task.id } } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: task.id } } })).toBe(0);
      expect(await tx.operationTaskMutation.count({ where: { taskId: task.id } })).toBe(2);
    });
  });
  it("retains stale proxy conflicts and requires a fresh reviewed operation instead of changing its original version", async () => {
    const f = await fixture(), task = await assigned(f), batch = queuedProxy(task, f.ctx);
    await saveOperationProgress(f.workerCtx, { taskId: task.id,
      checklistItemIds: task.checklistItems.map(item => item.id), idempotencyKey: randomUUID() }, deps());
    const conflict = (await pushSyncOps(f.ctx, batch, deps())).results[0];
    expect(conflict).toMatchObject({ status: "CONFLICT", error_code: "TASK_PROXY_VALIDATION_CONFLICT",
      conflict: { expected: String(task.version), incoming: "field_task.proxy_validate" } });
    const current = (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task;
    const changed = parsedBatch({ ...batch, ops: [{ ...batch.ops[0], payload: { ...batch.ops[0].payload, expectedVersion: current.version } }] });
    expect((await pushSyncOps(f.ctx, changed, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_IDEMPOTENCY_KEY_REUSED" });
    expect((await pushSyncOps(f.ctx, batch, deps())).results[0]).toEqual(conflict);
    expect((await pushSyncOps(f.ctx, queuedProxy(current, f.ctx), deps())).results[0].status).toBe("APPLIED");
    await withTenant(db, f.org, async tx => {
      expect(await tx.syncOp.count({ where: { status: "CONFLICT" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } })).toBe(1);
    });
  });
  it("persists proxy permission denial and isolates forged sessions and foreign task payloads", async () => {
    const f = await fixture(), other = await fixture(), task = await assigned(f), batch = queuedProxy(task, f.ctx);
    const denied = actor(f.org, f.account.id, f.person.id, new Set(["task:view", "task:edit"]));
    const rejected = (await pushSyncOps(denied, batch, deps())).results[0];
    expect(rejected).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    expect((await pushSyncOps(f.ctx, batch, deps())).results[0]).toEqual(rejected);
    expect((await pushSyncOps(other.ctx, batch, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_SESSION_CHANGED" });
    const foreign = parsedBatch({ ...batch, organization_id: other.org, actor_user_id: other.account.id });
    expect((await pushSyncOps(other.ctx, foreign, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_NOT_ASSIGNED" });
    await withTenant(db, f.org, async tx => {
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } })).state).toBe("ASSIGNED");
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } })).toBe(0);
      expect(await tx.syncOp.count({ where: { organizationId: other.org } })).toBe(0);
    });
    expect((await pushSyncOps(f.ctx, queuedProxy(task, f.ctx), deps())).results[0].status).toBe("APPLIED");
  });
  it("converges native form and queued proxy submissions sharing the same original key", async () => {
    const f = await fixture(), task = await assigned(f), batch = queuedProxy(task, f.ctx), op = batch.ops[0];
    if (op.type !== "field_task.proxy_validate") throw new Error("Expected supervisor operation");
    const results = await Promise.all([
      proxyCompleteOperationTask(f.ctx, { ...op.payload, idempotencyKey: op.client_op_id }, deps()),
      pushSyncOps(f.ctx, batch, deps())
    ]);
    expect(results[0].completionSource).toBe("PROXY");expect(results[1].results[0].status).toBe("APPLIED");
    await withTenant(db, f.org, async tx => {
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "ProxyValidated", payload: { path: ["taskId"], equals: task.id } } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: task.id } } })).toBe(0);
    });
  });
  it("rechecks the intersection of current view and validation scope for native and queued proxy writes", async () => {
    const f = await fixture(), task = await assigned(f), batch = queuedProxy(task, f.ctx), op = batch.ops[0];
    if (op.type !== "field_task.proxy_validate") throw new Error("Expected supervisor operation");
    const validation = { permissions: new Set(["task:validate"]), scope: { organizationId: f.org, scopeType: "property" as const, scopeId: task.propertyId } };
    const view = { permissions: new Set(["task:view"]), scope: { organizationId: f.org, scopeType: "property" as const, scopeId: randomUUID() as string } };
    const scoped = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [view, validation] } };
    await expect(proxyCompleteOperationTask(scoped, { ...op.payload, idempotencyKey: op.client_op_id }, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    expect((await pushSyncOps(scoped, batch, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    const expired = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [validation, { ...view, scope: { ...view.scope, scopeId: task.propertyId }, validTo: new Date("2001-01-01") }] } };
    expect((await pushSyncOps(expired, queuedProxy(task, f.ctx), deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    await withTenant(db, f.org, async tx => {
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } })).state).toBe("ASSIGNED");
      expect(await tx.auditLog.count({ where: { action: "task.proxy_validation.created", resourceId: task.id } })).toBe(0);
    });
    const allowed = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [validation, { ...view, scope: { ...view.scope, scopeId: task.propertyId } }] } };
    expect((await pushSyncOps(allowed, queuedProxy(task, f.ctx), deps())).results[0].status).toBe("APPLIED");
  });
  it("keeps a person-only performer separate from the queued validator without fabricating an account", async () => {
    const f = await fixture(), created = await assigned(f);
    const person = await withTenant(db, f.org, tx => tx.person.create({ data: { organizationId: f.org, displayName: "Person-only offline colleague" } }));
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: created.id }, data: { assignedToPersonId: person.id, assignedToUserAccountId: null } }));
    const task = (await operationTaskDetail(f.ctx, created.id, undefined, deps())).task;
    expect((await pushSyncOps(f.ctx, queuedProxy(task, f.ctx), deps())).results[0].status).toBe("APPLIED");
    await withTenant(db, f.org, async tx => {
      expect(await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ completionSource: "PROXY", completedByPersonId: person.id,
        completedByUserAccountId: null, validatedByUserAccountId: f.account.id, validatedByPersonId: f.person.id });
      expect(await tx.userAccount.count({ where: { personId: person.id } })).toBe(0);
    });
  });
  it("serializes opposing queued validators across devices without a performer-lock deadlock", async () => {
    const f = await fixture(), first = await assigned(f), second = await assigned(f);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: second.id }, data: { assignedToPersonId: f.person.id, assignedToUserAccountId: f.account.id } }));
    const current = (await operationTaskDetail(f.ctx, second.id, undefined, deps())).task;
    const validator = actor(f.org, f.workerAccount.id, f.worker.id), a = queuedProxy(first, f.ctx), b = queuedProxy(current, validator);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => pushSyncOps(index % 2 ? validator : f.ctx, index % 2 ? b : a, deps())));
    expect(results.flatMap(result => result.results).filter(result => result.status === "APPLIED")).toHaveLength(2);
    expect(results.flatMap(result => result.results).filter(result => result.status === "DUPLICATE")).toHaveLength(6);
    await withTenant(db, f.org, async tx => {
      expect(await tx.auditLog.count({ where: { action: "task.proxy_validation.created" } })).toBe(2);
      expect(await tx.outboxEvent.count({ where: { type: "ProxyValidated" } })).toBe(2);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted" } })).toBe(0);
    });
  });
  it("serializes concurrent device retries and records one completion with explicit duplicate-completion acknowledgement", async () => {
    const f = await fixture(), task = await assigned(f), batch = queued(task);
    const results = await Promise.all(Array.from({ length: 6 }, () => pushSyncOps(f.workerCtx, batch, deps())));
    expect(results.flatMap(result => result.results).map(result => result.status).sort()).toEqual(["APPLIED", ...Array.from({ length: 5 }, () => "DUPLICATE")]);
    const second = { ...batch, ops: [{ ...batch.ops[0], client_op_id: randomUUID() }] };
    expect((await pushSyncOps(f.workerCtx, second, deps())).results[0]).toMatchObject({ status: "DUPLICATE", error_code: "DUPLICATE_COMPLETION" });
    expect((await pushSyncOps(f.workerCtx, second, deps())).results[0]).toMatchObject({ status: "DUPLICATE", error_code: "DUPLICATE_COMPLETION" });
    await withTenant(db, f.org, async tx => {
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.complete" } })).toBe(1);
      expect(await tx.syncOp.count()).toBe(2);
      const saved = await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(saved.completionIdempotencyKey).toBe(batch.ops[0].client_op_id);
      expect(saved.completedAt!.getTime()).toBeGreaterThan(Date.parse("2026-01-01"));
      const op = await tx.syncOp.findFirstOrThrow({ where: { clientOpId: batch.ops[0].client_op_id } });
      expect(op.clientCreatedAt?.toISOString()).toBe(batch.ops[0].client_created_at);
      expect(op.createdAt.getTime()).toBeGreaterThan(op.clientCreatedAt!.getTime());
    });
  });

  it("preserves rejected reassignment evidence on replay and rejects changed payloads and other actors", async () => {
    const f = await fixture(), task = await assigned(f), batch = queued(task);
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: task.id }, data: { assignedToUserAccountId: f.account.id, assignedToPersonId: f.person.id } }));
    const rejected = (await pushSyncOps(f.workerCtx, batch, deps())).results[0];
    expect(rejected).toMatchObject({ status: "REJECTED", error_code: "REJECTED_NOT_ASSIGNED" });
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: task.id }, data: { assignedToUserAccountId: f.workerAccount.id, assignedToPersonId: f.worker.id } }));
    expect((await pushSyncOps(f.workerCtx, batch, deps())).results[0]).toEqual(rejected);
    const changed = structuredClone(batch);
    if (changed.ops[0].type !== "field_task.complete") throw new Error("Expected queued completion fixture");
    changed.ops[0].payload.note = "Replaced evidence";
    expect((await pushSyncOps(f.workerCtx, changed, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_IDEMPOTENCY_KEY_REUSED" });
    expect((await pushSyncOps(f.ctx, { ...batch, actor_user_id: f.ctx.actorId }, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_OP_OWNER", server_version: null });
    await withTenant(db, f.org, async tx => {
      const op = await tx.syncOp.findFirstOrThrow();
      expect(op.payload).toMatchObject({ note: "Offline field evidence" });
      expect(op.actorUserAccountId).toBe(f.workerAccount.id);
      expect(await tx.auditLog.count({ where: { action: "task.complete", resourceId: task.id } })).toBe(0);
    });
  });

  it("accepts the first valid completion across devices and publishes one completion event", async () => {
    const f = await fixture(), task = await assigned(f);
    const results = await Promise.all(Array.from({ length: 4 }, () => pushSyncOps(f.workerCtx, queued(task), deps())));
    expect(results.flatMap(result => result.results).map(result => result.status).sort()).toEqual(["APPLIED", "DUPLICATE", "DUPLICATE", "DUPLICATE"]);
    expect(results.flatMap(result => result.results).filter(result => result.error_code === "DUPLICATE_COMPLETION")).toHaveLength(3);
    await withTenant(db, f.org, async tx => {
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.complete" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: task.id } } })).toBe(1);
    });
  });

  it("keeps conflict results across retries and applies each concurrent batch in device order", async () => {
    const f = await fixture(), task = await assigned(f), batch = queued(task);
    const invalid = { ...batch.ops[0], client_op_id: randomUUID(), payload: { ...batch.ops[0].payload, checklistItemIds: [randomUUID()] } };
    batch.ops.unshift(invalid);
    const [first, retry] = await Promise.all([pushSyncOps(f.workerCtx, batch, deps()), pushSyncOps(f.workerCtx, batch, deps())]);
    expect(first.results[0]).toMatchObject({ status: "CONFLICT", error_code: "TASK_COMPLETION_CONFLICT" });
    expect(retry.results[0]).toEqual(first.results[0]);
    expect([first.results[1].status, retry.results[1].status].sort()).toEqual(["APPLIED", "DUPLICATE"]);
    expect((await pushSyncOps(f.workerCtx, batch, deps())).results[0]).toEqual(first.results[0]);
  });

  it("isolates tenant operation keys and refuses a stale browser's session ownership hints", async () => {
    const f = await fixture(), other = await fixture(), task = await assigned(f), foreignTask = await assigned(other), batch = queued(task);
    await pushSyncOps(f.workerCtx, batch, deps());
    expect((await pushSyncOps(other.workerCtx, { ...batch, actor_user_id: f.workerAccount.id, organization_id: f.org }, deps())).results[0])
      .toMatchObject({ status: "REJECTED", error_code: "REJECTED_SESSION_CHANGED" });
    const foreign = { ...structuredClone(batch), organization_id: other.org, actor_user_id: other.workerAccount.id }; foreign.ops[0].payload = { ...foreign.ops[0].payload, taskId: foreignTask.id, checklistItemIds: foreignTask.checklistItems.map(item => item.id) };
    expect((await pushSyncOps(other.workerCtx, foreign, deps())).results[0].status).toBe("APPLIED");
    await withTenant(db, other.org, async tx => {
      expect(await tx.syncOp.count()).toBe(1);
      expect(await tx.syncOp.count({ where: { organizationId: f.org } })).toBe(0);
    });
  });

  it("persists permission denials per operation without treating a retry as successful", async () => {
    const f = await fixture(), task = await assigned(f), batch = queued(task);
    const denied = actor(f.org, f.workerAccount.id, f.worker.id, new Set(["task:view"]));
    expect((await pushSyncOps(denied, batch, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    expect((await pushSyncOps(f.workerCtx, batch, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    expect((await operationTaskDetail(f.ctx, task.id, undefined, deps())).task.state).toBe("ASSIGNED");
  });

  it("rolls back a failed database transaction and safely retries the same queued completion", async () => {
    const f = await fixture(), task = await assigned(f), batch = queued(task);
    const failing: TenantTransactionRunner = { $transaction: <T,>(work: (tx: TenantTransaction) => Promise<T>) => db.$transaction(async tx => {
      await work(tx);
      throw new Error("Connection failed before commit");
    }) };
    await expect(pushSyncOps(f.workerCtx, batch, { ...deps(), db: failing })).rejects.toThrow("Connection failed before commit");
    await withTenant(db, f.org, async tx => {
      expect(await tx.syncOp.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "task.complete", resourceId: task.id } })).toBe(0);
    });
    expect((await pushSyncOps(f.workerCtx, batch, deps())).results[0].status).toBe("APPLIED");
  });
  it("creates every task type idempotently, freezes checklists and maintains append-only version history", async () => {
    const f = await fixture(),
      value = input(f);
    const results = await Promise.all([
      createOperationTask(f.ctx, value, deps()),
      createOperationTask(f.ctx, value, deps()),
    ]);
    expect(results[0].id).toBe(results[1].id);
    const task = results[0];
    await expect(
      createOperationTask(f.ctx, { ...value, priority: "URGENT" }, deps()),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    for (const type of taskTypeSchema.options)
      await createOperationTask(f.ctx, input(f, { type }), deps());
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "ops.checklists",
        scopeType: "organization",
        effectiveFrom: new Date("2021-01-01"),
        reason: "Update the inspection catalog",
        value: {
          checklists: [
            {
              key: "inspection",
              name: { en: "Updated", fr: "Modifié" },
              items: [
                { key: "new", label: { en: "New step", fr: "Nouvelle étape" } },
              ],
            },
          ],
        },
      }),
    );
    expect(
      (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task
        .checklistItems[0].key,
    ).toBe("ready");
    const command = {
      taskId: task.id,
      expectedVersion: task.version,
      state: "BLOCKED",
      reason: "Access code unavailable",
      idempotencyKey: randomUUID(),
    };
    await transitionOperationTask(f.ctx, command, deps());
    await transitionOperationTask(f.ctx, command, deps());
    const history = await operationTaskDetail(
      f.ctx,
      task.id,
      undefined,
      deps(),
    );
    expect(history.events.map((e) => e.version)).toEqual([2, 1]);
    expect(history.events[0]).toMatchObject({
      actorId: f.ctx.actorId,
      reason: command.reason,
    });
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.operationTaskEvent.updateMany({ data: { reason: "changed" } }),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      transitionOperationTask(
        f.ctx,
        { ...command, state: "CANCELLED", idempotencyKey: randomUUID() },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
  });
  it("enforces tenant, property and command authorization before mutations", async () => {
    const f = await fixture(),
      other = await fixture(),
      task = await createOperationTask(f.ctx, input(f), deps());
    await expect(
      operationTaskDetail(other.ctx, task.id, undefined, deps()),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    await expect(
      createOperationTask(other.ctx, input(f), deps()),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    const denied = actor(
      f.org,
      f.ctx.actorId,
      f.ctx.personId,
      new Set(["task:view"]),
    );
    await expect(
      transitionOperationTask(
        denied,
        {
          taskId: task.id,
          expectedVersion: task.version,
          state: "CANCELLED",
          reason: "Unauthorized cancellation",
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
    const scoped = {
      ...f.ctx,
      authContext: {
        ...f.ctx.authContext,
        scopes: [
          {
            organizationId: f.org,
            scopeType: "property" as const,
            scopeId: randomUUID(),
          },
        ],
      },
    };
    await expect(
      operationTaskDetail(scoped, task.id, undefined, deps()),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
    expect(
      await withTenant(db, other.org, (tx) =>
        tx.operationTaskEvent.count({ where: { taskId: task.id } }),
      ),
    ).toBe(0);
    const roles = await admin.$queryRaw<
      Array<{ rolbypassrls: boolean; rolsuper: boolean }>
    >`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='alvillas_ops_tests'`;
    expect(roles[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
  it("paginates supervisor work including person-only assignees while excluding own and foreign tasks", async () => {
    const f = await fixture(), foreign = await fixture();
    await assigned(foreign);
    const ids: string[] = [];
    for (let index = 0; index < 51; index++) ids.push((await assigned(f)).id);
    const self = await assigned(f);
    await withTenant(db, f.org, async tx => {
      await tx.operationTask.update({ where: { id: ids[0] }, data: { assignedToUserAccountId: null } });
      await tx.operationTask.update({ where: { id: self.id }, data: { assignedToUserAccountId: f.account.id, assignedToPersonId: f.person.id } });
    });
    const first = await fieldProxyTasks(f.ctx, { page: 1 }, deps()), second = await fieldProxyTasks(f.ctx, { page: 2 }, deps());
    expect(first.count).toBe(51); expect(first.tasks).toHaveLength(50); expect(second.tasks).toHaveLength(1);
    expect(new Set([...first.tasks, ...second.tasks].map(row => row.id))).toEqual(new Set(ids));
    expect(Object.keys(first.tasks[0]).sort()).toEqual(["dueDate", "id", "propertyName", "title"]);
    await expect(fieldProxyTasks(f.workerCtx, { page: 1 }, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
  });
  it("intersects scoped view and validate grants and denies an expired validation grant", async () => {
    const f = await fixture(), task = await assigned(f);
    const view = { permissions: new Set(["task:view"]), scope: { organizationId: f.org, scopeType: "organization" as const } };
    const validation = { permissions: new Set(["task:validate"]), scope: { organizationId: f.org, scopeType: "property" as const, scopeId: randomUUID() as string } };
    const scoped = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [view, validation] } };
    expect((await fieldProxyTasks(scoped, { page: 1 }, deps())).tasks).toEqual([]);
    const other = await withTenant(db, f.org, tx => tx.property.create({ data: { organizationId: f.org, name: "Other supervisor scope",
      addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } }));
    expect(await fieldProxyTasks({ ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [
      { ...view, scope: { organizationId: f.org, scopeType: "property", scopeId: f.property.id } },
      { ...validation, scope: { ...validation.scope, scopeId: other.id } }] } }, { page: 1 }, deps())).toMatchObject({ count: 0, tasks: [] });
    scoped.authContext.assignments = [view, { ...validation, scope: { ...validation.scope, scopeId: task.propertyId } }];
    expect((await fieldProxyTasks(scoped, { page: 1 }, deps())).tasks.map(row => row.id)).toEqual([task.id]);
    const expired = { ...scoped, authContext: { ...scoped.authContext, assignments: [view, { ...validation, validTo: new Date("2001-01-01") }] } };
    expect(await fieldProxyTasks(expired, { page: 1 }, deps())).toMatchObject({ count: 0, tasks: [] });
    await expect(proxyCompleteOperationTask(expired, { taskId: task.id, expectedVersion: task.version,
      performedByPersonId: f.worker.id, checklistItemIds: task.checklistItems.map(item => item.id),
      reason: "Expired grant must not validate", idempotencyKey: randomUUID() }, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    const validationHere = { ...validation, scope: { ...validation.scope, scopeId: task.propertyId } };
    const command = { taskId: task.id, expectedVersion: task.version, performedByPersonId: f.worker.id,
      checklistItemIds: task.checklistItems.map(item => item.id), reason: "Current task data scope must also allow the validation", idempotencyKey: randomUUID() };
    const noMatchingView = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [validationHere,
      { ...view, scope: { organizationId: f.org, scopeType: "property" as const, scopeId: randomUUID() as string } }] } };
    await expect(proxyCompleteOperationTask(noMatchingView, command, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    const expiredView = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [validationHere,
      { ...view, validTo: new Date("2001-01-01") }] } };
    await expect(proxyCompleteOperationTask(expiredView, command, deps())).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await withTenant(db, f.org, async tx => {
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } })).state).toBe("ASSIGNED");
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.proxy_validation.created" } })).toBe(0);
    });
  });
  it("requires exact checklists, distinct assigned performer and validator and records proxy identity exactly once", async () => {
    const f = await fixture(),
      task = await assigned(f);
    const command = {
      taskId: task.id,
      expectedVersion: task.version,
      performedByPersonId: f.worker.id,
      checklistItemIds: task.checklistItems.map((i) => i.id),
      reason: "Worker has no connection",
      idempotencyKey: randomUUID(),
    };
    await expect(
      proxyCompleteOperationTask(f.workerCtx, command, deps()),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(
      proxyCompleteOperationTask(
        f.ctx,
        { ...command, performedByPersonId: f.person.id },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    await expect(
      proxyCompleteOperationTask(
        f.ctx,
        { ...command, checklistItemIds: [randomUUID()] },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    const completed = await proxyCompleteOperationTask(f.ctx, command, deps());
    expect(completed).toMatchObject({
      state: "COMPLETED",
      completedByPersonId: f.worker.id,
      completedByUserAccountId: f.workerAccount.id,
      validatedByPersonId: f.person.id,
      validatedByUserAccountId: f.account.id,
      validationReason: command.reason,
      completionSource: "PROXY",
    });
    expect(
      completed.checklistItems.every(
        (i) => i.completedByPersonId === f.worker.id,
      ),
    ).toBe(true);
    await proxyCompleteOperationTask(f.ctx, command, deps());
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({
          where: {
            resourceId: task.id,
            action: "task.proxy_validation.created",
          },
        }),
      ),
    ).toBe(1);
    const history = await operationTaskDetail(
      f.ctx,
      task.id,
      undefined,
      deps(),
    );
    expect(history.events.map((e) => e.version)).toEqual([4, 3, 2, 1]);
  });
  it("proxy-validates a staff profile without a login and rejects unvalidated person-only checklist writes", async () => {
    const f = await fixture();
    const person = await withTenant(db, f.org, (tx) =>
      tx.person.create({
        data: { organizationId: f.org, displayName: "Staff without a login" },
      }),
    );
    const created = await createOperationTask(f.ctx, input(f), deps());
    await withTenant(db, f.org, (tx) =>
      tx.operationTask.update({
        where: { id: created.id },
        data: {
          state: "ASSIGNED",
          assignedToPersonId: person.id,
          assignedToUserAccountId: null,
        },
      }),
    );
    const task = (
      await operationTaskDetail(f.ctx, created.id, undefined, deps())
    ).task;
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.operationTaskChecklistItem.updateMany({
          where: { organizationId: f.org, taskId: task.id },
          data: {
            completedAt: new Date(),
            completedByPersonId: person.id,
            completedByUserAccountId: null,
          },
        }),
      ),
    ).rejects.toThrow(/audited proxy validation/i);
    const command = {
      taskId: task.id,
      expectedVersion: task.version,
      performedByPersonId: person.id,
      checklistItemIds: task.checklistItems.map((i) => i.id),
      reason: "Supervisor validates the staff profile without app access",
      idempotencyKey: randomUUID(),
    };
    const completed = await proxyCompleteOperationTask(f.ctx, command, deps());
    expect(completed).toMatchObject({
      state: "COMPLETED",
      completedByPersonId: person.id,
      completedByUserAccountId: null,
      validatedByPersonId: f.person.id,
      validatedByUserAccountId: f.account.id,
      completionSource: "PROXY",
    });
    expect(
      completed.checklistItems.every(
        (i) =>
          i.completedByPersonId === person.id &&
          i.completedByUserAccountId === null,
      ),
    ).toBe(true);
    await proxyCompleteOperationTask(f.ctx, command, deps());
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({
          where: {
            organizationId: f.org,
            resourceId: task.id,
            action: "task.proxy_validation.created",
          },
        }),
      ),
    ).toBe(1);
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.operationTask.update({
          where: { id: task.id },
          data: { validatedByPersonId: person.id },
        }),
      ),
    ).rejects.toThrow(/audited proxy validation/i);
    expect(
      (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task
        .validatedByPersonId,
    ).toBe(f.person.id);
  });
  it("serializes worker completion, blocks cancelled work and records SELF rather than the validator", async () => {
    const f = await fixture(),
      task = await assigned(f);
    const value = {
      taskId: task.id,
      idempotencyKey: randomUUID(),
      checklistItemIds: task.checklistItems.map((i) => i.id),
    };
    await Promise.all([
      completeAssignedFieldTask(f.workerCtx, value, deps()),
      completeAssignedFieldTask(f.workerCtx, value, deps()),
    ]);
    const completed = (
      await operationTaskDetail(f.ctx, task.id, undefined, deps())
    ).task;
    expect(completed).toMatchObject({
      completionSource: "SELF",
      completedByPersonId: f.worker.id,
      validatedByPersonId: null,
    });
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({
          where: { resourceId: task.id, action: "task.complete" },
        }),
      ),
    ).toBe(1);
    const cancelled = await assigned(f);
    await transitionOperationTask(
      f.ctx,
      {
        taskId: cancelled.id,
        expectedVersion: cancelled.version,
        state: "CANCELLED",
        reason: "Guest cancelled the service",
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    await expect(
      completeAssignedFieldTask(
        f.workerCtx,
        {
          ...value,
          taskId: cancelled.id,
          checklistItemIds: cancelled.checklistItems.map((i) => i.id),
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
  });
  it("assigns preferred then fallback staff, excludes approved leave and rejects unauthorized or stale reassignment", async () => {
    const f = await fixture(),
      c = await crew(f),
      a = await createOperationTask(f.ctx, input(f), deps()),
      b = await createOperationTask(f.ctx, input(f), deps());
    const command = {
      taskId: a.id,
      expectedVersion: a.version,
      personId: null,
      startMinute: 540,
      reason: "Assign available operational staff",
      idempotencyKey: randomUUID(),
    };
    const first = await assignOperationTask(f.ctx, command, deps());
    expect(first.assignedToPersonId).toBe(f.worker.id);
    const replay = await assignOperationTask(f.ctx, command, deps());
    expect(replay.version).toBe(first.version);
    const second = await assignOperationTask(
      f.ctx,
      {
        ...command,
        taskId: b.id,
        expectedVersion: b.version,
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    expect(second.assignedToPersonId).toBe(c.fallback.id);
    await expect(
      assignOperationTask(
        f.workerCtx,
        {
          ...command,
          expectedVersion: first.version,
          personId: c.fallback.id,
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
    await expect(
      assignOperationTask(
        f.ctx,
        { ...command, personId: c.fallback.id, idempotencyKey: randomUUID() },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    await withTenant(db, f.org, (tx) =>
      tx.teamAvailability.create({
        data: {
          organizationId: f.org,
          personId: f.worker.id,
          kind: "LEAVE",
          startsOn: new Date("2027-04-11"),
          endsOn: new Date("2027-04-12"),
          status: "APPROVED",
          reason: "Approved leave",
          createdBy: f.account.id,
          decidedBy: f.account.id,
        },
      }),
    );
    await expect(
      rescheduleOperationTask(
        f.ctx,
        {
          taskId: first.id,
          expectedVersion: first.version,
          dueDate: "2027-04-11",
          startMinute: 540,
          reason: "Move assigned work to leave day",
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    await expect(
      rescheduleOperationTask(
        f.ctx,
        {
          taskId: first.id,
          expectedVersion: first.version,
          dueDate: "2027-04-10",
          startMinute: 1410,
          reason: "Avoid overnight work extending into approved leave",
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    const boundary = await rescheduleOperationTask(
      f.ctx,
      {
        taskId: first.id,
        expectedVersion: first.version,
        dueDate: "2027-04-10",
        startMinute: 1380,
        reason: "Finish at the exclusive start of approved leave",
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    const moved = await rescheduleOperationTask(
      f.ctx,
      {
        taskId: first.id,
        expectedVersion: boundary.version,
        dueDate: "2027-04-12",
        startMinute: 600,
        reason: "Move to an available day",
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    expect(moved.dueDate.toISOString().slice(0, 10)).toBe("2027-04-12");
  });
  it("serializes concurrent assignment across tasks and keeps denied cross-tenant and cross-scope changes atomic", async () => {
    const f = await fixture();
    await crew(f);
    const a = await createOperationTask(f.ctx, input(f), deps()),
      b = await createOperationTask(f.ctx, input(f), deps());
    const results = await Promise.allSettled(
      [a, b].map((t) =>
        assignOperationTask(
          f.ctx,
          {
            taskId: t.id,
            expectedVersion: t.version,
            personId: f.worker.id,
            startMinute: 540,
            reason: "Concurrent same-window assignment",
            idempotencyKey: randomUUID(),
          },
          deps(),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const other = await fixture();
    await expect(
      assignOperationTask(
        other.ctx,
        {
          taskId: a.id,
          expectedVersion: 1,
          personId: null,
          startMinute: 600,
          reason: "Wrong tenant assignment attempt",
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    const scoped = {
      ...f.ctx,
      authContext: {
        ...f.ctx.authContext,
        scopes: [
          {
            organizationId: f.org,
            scopeType: "property" as const,
            scopeId: randomUUID(),
          },
        ],
      },
    };
    await expect(
      assignOperationTask(
        scoped,
        {
          taskId: a.id,
          expectedVersion: 1,
          personId: null,
          startMinute: 600,
          reason: "Wrong property assignment attempt",
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
  });
  it("keeps same-day checkout and arrival work independent with adjacent nonoverlapping crew windows", async () => {
    const f = await fixture();
    await crew(f);
    const departure = await createOperationTask(
        f.ctx,
        input(f, { type: "CHECKOUT_CLEANING" }),
        deps(),
      ),
      arrival = await createOperationTask(
        f.ctx,
        input(f, { type: "ARRIVAL_PREPARATION" }),
        deps(),
      );
    const values = [
      { task: departure, startMinute: 720 },
      { task: arrival, startMinute: 900 },
    ];
    for (const { task, startMinute } of values)
      await assignOperationTask(
        f.ctx,
        {
          taskId: task.id,
          expectedVersion: task.version,
          personId: f.worker.id,
          startMinute,
          reason: "Prepare independent same-day turnover work",
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
    const a = (
        await operationTaskDetail(f.ctx, departure.id, undefined, deps())
      ).task,
      b = (await operationTaskDetail(f.ctx, arrival.id, undefined, deps()))
        .task;
    expect(a.assignedToPersonId).toBe(b.assignedToPersonId);
    expect(a.scheduledEnd!.getTime()).toBeLessThanOrEqual(
      b.scheduledStart!.getTime(),
    );
    await completeAssignedFieldTask(
      f.workerCtx,
      {
        taskId: a.id,
        checklistItemIds: a.checklistItems.map((i) => i.id),
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    expect(
      (await operationTaskDetail(f.ctx, b.id, undefined, deps())).task.state,
    ).toBe("ASSIGNED");
  });
  it("swaps eligible performers with optimistic versions and one audit event for each task", async () => {
    const f = await fixture(),
      c = await crew(f);
    const tasks = await Promise.all(
      [0, 1].map(() => createOperationTask(f.ctx, input(f), deps())),
    );
    const [a, b] = await Promise.all(
      tasks.map((t, i) =>
        assignOperationTask(
          f.ctx,
          {
            taskId: t.id,
            expectedVersion: t.version,
            personId: i ? c.fallback.id : f.worker.id,
            startMinute: 540,
            reason: "Schedule both operational workers",
            idempotencyKey: randomUUID(),
          },
          deps(),
        ),
      ),
    );
    const value = {
      taskId: a.id,
      otherTaskId: b.id,
      expectedVersion: a.version,
      otherVersion: b.version,
      reason: "Swap the eligible assigned workers",
      idempotencyKey: randomUUID(),
    };
    const swapped = await swapOperationTasks(f.ctx, value, deps());
    expect(swapped.map((t) => t.assignedToPersonId)).toEqual([
      c.fallback.id,
      f.worker.id,
    ]);
    await swapOperationTasks(f.ctx, value, deps());
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({
          where: { organizationId: f.org, action: "task.assignment.swapped" },
        }),
      ),
    ).toBe(2);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.outboxEvent.count({
          where: {
            organizationId: f.org,
            payload: { path: ["kind"], equals: "task_assigned" },
          },
        }),
      ),
    ).toBe(4);
  });
  it("scopes swap choices before limiting rows so unrelated properties cannot hide authorized work", async () => {
    const f = await fixture(),
      c = await crew(f);
    const a = await createOperationTask(f.ctx, input(f), deps()),
      b = await createOperationTask(f.ctx, input(f), deps());
    for (const [task, personId] of [
      [a, f.worker.id],
      [b, c.fallback.id],
    ] as const)
      await assignOperationTask(
        f.ctx,
        {
          taskId: task.id,
          expectedVersion: task.version,
          personId,
          startMinute: 540,
          reason: "Schedule scoped swap options",
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
    await withTenant(db, f.org, async (tx) => {
      const outside = await tx.property.create({
        data: {
          organizationId: f.org,
          name: "Outside assigned scope",
          addressLine1: "Test",
          city: "Marrakech",
          propertyType: "VILLA",
          bedrooms: 2,
          bathrooms: 2,
          maxGuests: 4,
          amenities: [],
          photoUrls: [],
        },
      });
      await tx.operationTask.createMany({
        data: Array.from({ length: 205 }, () => ({
          organizationId: f.org,
          propertyId: outside.id,
          type: "INSPECTION",
          state: "ASSIGNED",
          assignedToPersonId: f.worker.id,
          dueDate: new Date("2020-01-01"),
          titleTranslations: {
            en: "Outside inspection",
            fr: "Inspection externe",
          },
          idempotencyKey: randomUUID(),
        })),
      });
    });
    const ctx = {
      ...f.ctx,
      authContext: {
        ...f.ctx.authContext,
        scopes: [
          {
            organizationId: f.org,
            scopeType: "property" as const,
            scopeId: f.property.id,
          },
        ],
      },
    };
    const options = await operationAssignmentOptions(ctx, a.id, deps());
    expect(options.swapTasks.map((t) => t.id)).toEqual([b.id]);
  });
  it("generates recurring occurrences idempotently and derives readiness and overdue events in property time", async () => {
    const f = await fixture();
    await crew(f);
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "ops.recurring_tasks",
        scopeType: "property",
        scopeId: f.property.id,
        createdBy: f.account.id,
        effectiveFrom: new Date("2020-01-01"),
        reason: "Configure daily readiness inspections",
        value: {
          series: [
            {
              key: "daily-inspection",
              type: "INSPECTION",
              title: { en: "Daily inspection", fr: "Inspection quotidienne" },
              checklist_template_key: "inspection",
              starts_on: "2027-04-10",
              ends_on: null,
              every_days: 1,
              weekdays: [0, 1, 2, 3, 4, 5, 6],
              start_minute: 540,
              priority: "NORMAL",
              enabled: true,
            },
          ],
        },
      }),
    );
    const value = {
        propertyId: f.property.id,
        from: "2027-04-10",
        until: "2027-04-11",
      },
      options = { ...deps(), now: new Date("2027-04-10T12:00:00Z") };
    const results = await Promise.all([
      generateRecurringOperations(f.ctx, value, options),
      generateRecurringOperations(f.ctx, value, options),
    ]);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(2);
    const ready = await operationReadiness(f.ctx, options);
    expect(ready[0]).toMatchObject({ readiness: "NOT_READY", overdue: 1 });
    await scheduleOperationTasks(f.org, options);
    await scheduleOperationTasks(f.org, options);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.outboxEvent.count({
          where: { organizationId: f.org, type: "TaskOverdue" },
        }),
      ),
    ).toBe(1);
    const task = await withTenant(db, f.org, (tx) =>
      tx.operationTask.findFirstOrThrow({
        where: { organizationId: f.org, dueDate: new Date("2027-04-10") },
        include: { checklistItems: true },
      }),
    );
    await completeAssignedFieldTask(
      f.workerCtx,
      {
        taskId: task.id,
        idempotencyKey: randomUUID(),
        checklistItemIds: task.checklistItems.map((i) => i.id),
      },
      deps(),
    );
    expect((await operationReadiness(f.ctx, options))[0].readiness).toBe(
      "READY",
    );
    await expect(
      generateRecurringOperations(
        f.ctx,
        { ...value, until: "2028-04-11" },
        options,
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
  });
  it("bounds recurring batches, preserves occurrence identity and exposes revoked scheduler access", async () => {
    const f = await fixture();
    await crew(f);
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "ops.recurring_tasks",
        scopeType: "property",
        scopeId: f.property.id,
        createdBy: f.account.id,
        effectiveFrom: new Date("2020-01-01"),
        reason: "Bounded recurring batch verification",
        value: {
          series: [
            {
              key: "bounded",
              type: "POOL",
              title: { en: "Pool inspection", fr: "Inspection piscine" },
              checklist_template_key: "inspection",
              starts_on: "2027-04-10",
              ends_on: null,
              every_days: 1,
              weekdays: [0, 1, 2, 3, 4, 5, 6],
              start_minute: 540,
              priority: "NORMAL",
              enabled: true,
            },
          ],
        },
      }),
    );
    const options = { ...deps(), now: new Date("2027-04-10T12:00:00Z") },
      command = {
        propertyId: f.property.id,
        from: "2027-04-10",
        until: "2027-04-24",
      };
    expect(
      await generateRecurringOperations(f.ctx, command, options),
    ).toMatchObject({ created: 10, more: true });
    expect(
      await generateRecurringOperations(f.ctx, command, options),
    ).toMatchObject({ created: 5, more: false });
    expect(
      await generateRecurringOperations(f.ctx, command, options),
    ).toMatchObject({ created: 0, existing: 15, more: false });
    await withTenant(db, f.org, (tx) =>
      tx.roleAssignment.updateMany({
        where: { userAccountId: f.account.id },
        data: { validTo: new Date("2020-01-02") },
      }),
    );
    await scheduleOperationTasks(f.org, options);
    expect((await operationReadiness(f.ctx, options))[0].generationFailed).toBe(
      true,
    );
    await withTenant(db, f.org, (tx) =>
      tx.roleAssignment.updateMany({
        where: { userAccountId: f.account.id },
        data: { validTo: null },
      }),
    );
    await scheduleOperationTasks(f.org, options);
    expect((await operationReadiness(f.ctx, options))[0].generationFailed).toBe(
      false,
    );
  });
  it("edits and pauses effective recurring series without cancelling begun work or accepting stale configuration", async () => {
    const f = await fixture();
    await crew(f);
    const options = { ...deps(), now: new Date("2027-04-10T12:00:00Z") };
    const definition = {
      key: "pause-verification",
      type: "CLEANING",
      title: { en: "Daily cleaning", fr: "Nettoyage quotidien" },
      checklist_template_key: "inspection",
      starts_on: "2027-04-10",
      ends_on: "2027-04-12",
      every_days: 1,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start_minute: 540,
      priority: "NORMAL",
      enabled: true,
    };
    const command = {
      propertyId: f.property.id,
      expectedVersion: 0,
      definition,
      cancelFuture: false,
      reason: "Configure effective recurring cleaning",
    };
    await expect(
      saveOperationSeries(f.workerCtx, command, options),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
    const rule = await saveOperationSeries(f.ctx, command, options);
    expect(
      (await operationSeriesOptions(f.ctx, f.property.id, options)).version,
    ).toBe(rule.version);
    expect(
      (
        await generateRecurringOperations(
          f.ctx,
          {
            propertyId: f.property.id,
            from: "2027-04-10",
            until: "2027-04-12",
          },
          options,
        )
      ).created,
    ).toBe(3);
    const tasks = await withTenant(db, f.org, (tx) =>
      tx.operationTask.findMany({
        where: { organizationId: f.org, seriesKey: definition.key },
        orderBy: { dueDate: "asc" },
      }),
    );
    await transitionOperationTask(
      f.ctx,
      {
        taskId: tasks[1].id,
        expectedVersion: tasks[1].version,
        state: "IN_PROGRESS",
        reason: "Worker has already begun this checklist",
        idempotencyKey: randomUUID(),
      },
      options,
    );
    const paused = await saveOperationSeries(
      f.ctx,
      {
        ...command,
        expectedVersion: rule.version,
        definition: { ...definition, enabled: false },
        cancelFuture: true,
        reason: "Pause future cleaning while preserving begun work",
      },
      options,
    );
    expect(paused.version).toBe(rule.version + 1);
    const states = await withTenant(db, f.org, (tx) =>
      tx.operationTask.findMany({
        where: { organizationId: f.org, seriesKey: definition.key },
        orderBy: { dueDate: "asc" },
        select: { state: true },
      }),
    );
    expect(states.map((t) => t.state)).toEqual([
      "CANCELLED",
      "IN_PROGRESS",
      "CANCELLED",
    ]);
    await expect(
      saveOperationSeries(
        f.ctx,
        { ...command, expectedVersion: rule.version },
        options,
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    expect(
      (
        await generateRecurringOperations(
          f.ctx,
          {
            propertyId: f.property.id,
            from: "2027-04-10",
            until: "2027-04-12",
          },
          options,
        )
      ).created,
    ).toBe(0);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({
          where: {
            organizationId: f.org,
            action: "task.recurrence.configured",
          },
        }),
      ),
    ).toBe(2);
  });
  it("paginates and monitors 500 properties without per-property SQL queries", async () => {
    const f = await fixture();
    await crew(f);
    const ids = Array.from({ length: 500 }, () => randomUUID());
    await withTenant(db, f.org, async (tx) => {
      await tx.property.createMany({
        data: ids.map((id, i) => ({
          id,
          organizationId: f.org,
          name: `Scale villa ${i}`,
          addressLine1: "Test",
          city: "Marrakech",
          propertyType: "VILLA",
          bedrooms: 2,
          bathrooms: 2,
          maxGuests: 4,
          amenities: [],
          photoUrls: [],
        })),
      });
      await tx.operationTask.createMany({
        data: ids.map((id) => ({
          organizationId: f.org,
          propertyId: id,
          type: "INSPECTION",
          state: "PLANNED",
          dueDate: new Date("2027-04-10"),
          titleTranslations: { en: "Scale inspection", fr: "Inspection" },
          idempotencyKey: `scale:${id}`,
        })),
      });
    });
    const target = new URL(url!);
    target.username = "alvillas_ops_tests";
    target.password = "alvillas_ops_tests";
    const probe = new PrismaClient({
      datasourceUrl: target.toString(),
      log: [{ emit: "event", level: "query" }],
    });
    let queries = 0;
    probe.$on("query", () => queries++);
    try {
      const list = await operationManagement(
        f.ctx,
        {},
        { ...deps(), db: probe },
      );
      expect(list.count).toBe(500);
      expect(list.tasks).toHaveLength(50);
      const readiness = await operationReadiness(f.ctx, {
        ...deps(),
        db: probe,
        now: new Date("2027-04-10T12:00:00Z"),
      });
      expect(readiness).toHaveLength(501);
      expect(queries).toBeLessThan(45);
    } finally {
      await probe.$disconnect();
    }
  });
  it("keeps an explicitly filtered property board bounded under500 unrelated properties and denies foreign filters",async()=>{
    const f=await fixture();await crew(f);const target=await createOperationTask(f.ctx,input(f),deps());
    await withTenant(db,f.org,tx=>tx.property.createMany({data:Array.from({length:500},(_,i)=>({organizationId:f.org,name:"Unrelated filtered-board property "+i,addressLine1:"Actual scale source",city:"Marrakech",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}))}));
    const all=vi.spyOn(OperationRepository.prototype,"properties"),policies=vi.spyOn(OperationRepository.prototype,"policies");
    try{const board=await operationManagement(f.ctx,{propertyId:f.property.id},deps());expect(board.count).toBe(1);expect(board.tasks.map(row=>row.id)).toEqual([target.id]);expect(all).not.toHaveBeenCalled();expect(policies).toHaveBeenCalledWith([f.property.id],expect.any(Date));const foreign=await fixture();const hidden=await operationManagement(f.ctx,{propertyId:foreign.property.id},deps());expect(hidden.count).toBe(0);expect(hidden.tasks).toEqual([]);expect(all).not.toHaveBeenCalled();}finally{all.mockRestore();policies.mockRestore();}
  });
  it("filters before pagination, keeps saved views private and applies bulk changes atomically and idempotently", async () => {
    const f = await fixture();
    await crew(f);
    const tasks = await Promise.all(
      Array.from({ length: 53 }, (_, i) =>
        createOperationTask(
          f.ctx,
          input(f, { title: { en: `Task ${i}`, fr: `Tâche ${i}` } }),
          deps(),
        ),
      ),
    );
    const first = await operationManagement(
        f.ctx,
        { propertyId: f.property.id },
        deps(),
      ),
      second = await operationManagement(
        f.ctx,
        { propertyId: f.property.id, page: 2 },
        deps(),
      );
    expect(first.count).toBe(53);
    expect(first.tasks).toHaveLength(50);
    expect(second.tasks).toHaveLength(3);
    const view = await saveOperationView(
      f.ctx,
      {
        name: "My inspections",
        filters: {
          propertyId: f.property.id,
          type: "INSPECTION",
          view: "WEEK",
          date: "2027-04-10",
        },
      },
      deps(),
    );
    expect(
      (await operationManagement(f.workerCtx, {}, deps())).views,
    ).toHaveLength(0);
    await archiveOperationView(f.workerCtx, view.id, deps());
    expect((await operationManagement(f.ctx, {}, deps())).views).toHaveLength(
      1,
    );
    const value = {
      items: tasks
        .slice(0, 2)
        .map((t) => ({ taskId: t.id, expectedVersion: t.version })),
      action: "PRIORITY",
      personId: null,
      priority: "URGENT",
      startMinute: 540,
      reason: "Prioritize the next guest arrival",
      idempotencyKey: randomUUID(),
    };
    expect((await bulkOperationTasks(f.ctx, value, deps())).changed).toBe(2);
    expect((await bulkOperationTasks(f.ctx, value, deps())).idempotent).toBe(
      true,
    );
    const other = await fixture(),
      foreign = await createOperationTask(other.ctx, input(other), deps());
    await expect(
      bulkOperationTasks(
        f.ctx,
        {
          ...value,
          items: [
            { taskId: tasks[2].id, expectedVersion: 1 },
            { taskId: foreign.id, expectedVersion: 1 },
          ],
          idempotencyKey: randomUUID(),
        },
        deps(),
      ),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    expect(
      (await operationTaskDetail(f.ctx, tasks[2].id, undefined, deps())).task
        .priority,
    ).toBe("HIGH");
    for (const [index, startMinute] of [
      [0, 900],
      [1, 540],
    ] as const) {
      const current = (
        await operationTaskDetail(f.ctx, tasks[index].id, undefined, deps())
      ).task;
      await rescheduleOperationTask(
        f.ctx,
        {
          taskId: current.id,
          expectedVersion: current.version,
          dueDate: "2027-04-10",
          startMinute,
          reason: "Verify scheduled chronological display order",
          idempotencyKey: randomUUID(),
        },
        deps(),
      );
    }
    const timeline = await operationManagement(
      f.ctx,
      { view: "TIMELINE", date: "2027-04-10", propertyId: f.property.id },
      deps(),
    );
    expect(timeline.tasks.slice(0, 2).map((t) => t.id)).toEqual([
      tasks[1].id,
      tasks[0].id,
    ]);
    expect(timeline.tasks[2].scheduledStart).toBeNull();
    for (const view of ["TIMELINE", "LIST", "DAY", "WEEK", "MONTH"])
      expect(
        (
          await operationManagement(
            f.ctx,
            { view, date: "2027-04-10", propertyId: f.property.id },
            deps(),
          )
        ).count,
      ).toBe(53);
    await archiveOperationView(f.ctx, view.id, deps());
    expect((await operationManagement(f.ctx, {}, deps())).views).toHaveLength(
      0,
    );
  });
  it("uses configured task times for bulk assignment and preserves them when rescheduling without a time override", async () => {
    const f = await fixture();
    await crew(f);
    const task = await createOperationTask(
      f.ctx,
      input(f, { type: "CHECKOUT_CLEANING" }),
      deps(),
    );
    const command = {
      items: [{ taskId: task.id, expectedVersion: task.version }],
      action: "ASSIGN",
      personId: null,
      reason: "Bulk assign with the configured checkout schedule",
      idempotencyKey: randomUUID(),
    };
    await bulkOperationTasks(f.ctx, command, deps());
    const assigned = (
      await operationTaskDetail(f.ctx, task.id, undefined, deps())
    ).task;
    const minute = (time: Date) =>
      Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: assigned.property.timezone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(time),
      ) *
        60 +
      Number(
        new Intl.DateTimeFormat("en-US", {
          timeZone: assigned.property.timezone,
          minute: "2-digit",
        }).format(time),
      );
    expect(minute(assigned.scheduledStart!)).toBe(720);
    expect(assigned.assignedToPersonId).toBe(f.worker.id);
    await bulkOperationTasks(
      f.ctx,
      {
        ...command,
        items: [{ taskId: task.id, expectedVersion: assigned.version }],
        action: "RESCHEDULE",
        dueDate: "2027-04-11",
        reason: "Move the date while preserving the configured slot",
        idempotencyKey: randomUUID(),
      },
      deps(),
    );
    const moved = (await operationTaskDetail(f.ctx, task.id, undefined, deps()))
      .task;
    expect(minute(moved.scheduledStart!)).toBe(720);
    expect(moved.dueDate.toISOString().slice(0, 10)).toBe("2027-04-11");
  });
  it("does not re-emit task completion events when evidence or issues are added after completion", async () => {
    const f = await fixture(), selfTask = await assigned(f);
    await completeAssignedFieldTask(f.workerCtx, { taskId: selfTask.id, idempotencyKey: randomUUID(),
      checklistItemIds: selfTask.checklistItems.map(item => item.id), note: "Assigned worker completion" }, deps());
    const evidence = { taskId: selfTask.id, note: "Additional completed-task evidence", idempotencyKey: randomUUID() };
    await Promise.all([attachOperationEvidence(f.workerCtx, evidence, undefined, deps()), attachOperationEvidence(f.workerCtx, evidence, undefined, deps())]);
    await reportOperationIssue(f.ctx, { taskId: selfTask.id, title: "Follow-up observation", description: "Observed after the task was completed",
      severity: "LOW", idempotencyKey: randomUUID() }, deps());
    const proxyTask = await assigned(f);
    await proxyCompleteOperationTask(f.ctx, { taskId: proxyTask.id, expectedVersion: proxyTask.version, performedByPersonId: f.worker.id,
      checklistItemIds: proxyTask.checklistItems.map(item => item.id), reason: "Supervisor verified the performer completed the checklist", idempotencyKey: randomUUID() }, deps());
    await attachOperationEvidence(f.ctx, { taskId: proxyTask.id, note: "Additional supervisor evidence", idempotencyKey: randomUUID() }, undefined, deps());
    await withTenant(db, f.org, async tx => {
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: selfTask.id } } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "TaskCompleted", payload: { path: ["taskId"], equals: proxyTask.id } } })).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: "ProxyValidated", payload: { path: ["taskId"], equals: proxyTask.id } } })).toBe(1);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: { in: [selfTask.id, proxyTask.id] } } })).toBe(2);
      expect(await tx.auditLog.count({ where: { action: "task.evidence.attached", resourceId: { in: [selfTask.id, proxyTask.id] } } })).toBe(2);
    });
  });
  it("persists assigned checklist progress, verifies private photo bytes and preserves issue and evidence history", async () => {
    const f = await fixture(),
      task = await assigned(f);
    const progress = {
      taskId: task.id,
      idempotencyKey: randomUUID(),
      checklistItemIds: task.checklistItems.map((i) => i.id),
    };
    await saveOperationProgress(f.workerCtx, progress, deps());
    await saveOperationProgress(f.workerCtx, progress, deps());
    expect(
      (await operationTaskDetail(f.ctx, task.id, undefined, deps())).task.state,
    ).toBe("IN_PROGRESS");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==",
      "base64",
    );
    let puts = 0;
    const storage = {
      createSignedUploadUrl: () =>
        Promise.resolve({ url: "https://storage.test/upload" }),
      createSignedDownloadUrl: () =>
        Promise.resolve({ url: "https://storage.test/download" }),
    };
    const transport: typeof fetch = (_url, init) => {
      if (init?.method === "PUT") {
        puts++;
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      return Promise.resolve(
        new Response(new Uint8Array(bytes), { status: 200 }),
      );
    };
    const value = {
        taskId: task.id,
        note: "Readiness inspection photo",
        contentType: "image/png",
        idempotencyKey: randomUUID(),
      },
      options = { ...deps(), storage, transport };
    const photo = await attachOperationEvidence(
      f.workerCtx,
      value,
      bytes,
      options,
    );
    await attachOperationEvidence(f.workerCtx, value, bytes, options);
    expect(puts).toBe(1);
    expect(
      (await downloadOperationEvidence(f.ctx, photo.id!, options)).bytes,
    ).toEqual(new Uint8Array(bytes));
    const other = await fixture();
    await expect(
      downloadOperationEvidence(other.ctx, photo.id!, options),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
    await expect(
      attachOperationEvidence(
        f.workerCtx,
        { ...value, idempotencyKey: randomUUID() },
        Buffer.from("not an image"),
        options,
      ),
    ).rejects.toBeInstanceOf(ReservationConflictError);
    const issue = {
      taskId: task.id,
      title: "Pool filter needs inspection",
      description: "The pool filter is making an unusual sound",
      severity: "HIGH",
      idempotencyKey: randomUUID(),
    };
    await expect(
      reportOperationIssue(f.workerCtx, issue, deps()),
    ).rejects.toBeInstanceOf(ReservationAuthorizationError);
    const issueId = await reportOperationIssue(f.ctx, issue, deps());
    expect(await reportOperationIssue(f.ctx, issue, deps())).toBe(issueId);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.operationIssue.count({
          where: { organizationId: f.org, taskId: task.id },
        }),
      ),
    ).toBe(1);
    await expect(
      withTenant(db, f.org, (tx) =>
        tx.operationTaskEvidence.deleteMany({ where: { taskId: task.id } }),
      ),
    ).rejects.toThrow(/append-only/);
    expect(
      (await operationTaskDetail(f.ctx, task.id, undefined, deps())).events
        .length,
    ).toBeGreaterThan(3);
  });

  it.skipIf(!url)("field issues serialize concurrent deliveries and cross-device retries into one issue, audit and outbox event", async () => {
    const f = await fixture(), task = await assigned(f), ctx = issueActor(f, task.id), batch = issueBatch(ctx, task.id);
    const results = await Promise.all(Array.from({ length: 4 }, () => pushSyncOps(ctx, batch, deps())));
    expect(results.flatMap(result => result.results.map(row => row.status)).sort()).toEqual(["APPLIED", "DUPLICATE", "DUPLICATE", "DUPLICATE"]);
    expect((await pushSyncOps(ctx, { ...batch, device_id: randomUUID() }, deps())).results[0].status).toBe("DUPLICATE");
    await withTenant(db, f.org, async tx => {
      const issues = await tx.operationIssue.findMany({ where: { taskId: task.id } }); expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ propertyId: task.propertyId, createdBy: ctx.actorId, state: "OPEN", evidenceId: null });
      expect(issues[0].createdAt.getUTCFullYear()).toBeLessThan(2077);
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.issue.reported" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "IssueReported", idempotencyKey: `issue:${issues[0].id}:reported` } })).toBe(1);
      expect((await tx.operationTask.findUniqueOrThrow({ where: { id: task.id } })).state).toBe("ASSIGNED");
    });
    const changed = structuredClone(batch); if (changed.ops[0].type !== "field_task.issue.report") throw new Error("Expected issue");
    changed.ops[0].payload.description = "Changed observation must not reuse the key";
    expect((await pushSyncOps(ctx, changed, deps())).results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_IDEMPOTENCY_KEY_REUSED" });
  });

  it.skipIf(!url)("field issues require create permission, the original assignee, tenant and actor at execution", async () => {
    const f = await fixture(), task = await assigned(f), other = await fixture();
    const denied = await pushSyncOps(f.workerCtx, issueBatch(f.workerCtx, task.id), deps());
    expect(denied.results[0]).toMatchObject({ status: "REJECTED", error_code: "REJECTED_FORBIDDEN" });
    expect((await pushSyncOps(f.ctx, issueBatch(f.ctx, task.id), deps())).results[0].status).toBe("REJECTED");
    expect((await pushSyncOps(other.ctx, issueBatch(other.ctx, task.id), deps())).results[0].status).toBe("REJECTED");
    const ctx = issueActor(f, task.id), stale = issueBatch(ctx, task.id);
    expect((await pushSyncOps(ctx, { ...stale, actor_user_id: randomUUID() }, deps())).results[0].error_code).toBe("REJECTED_SESSION_CHANGED");
    await withTenant(db, f.org, tx => tx.operationTask.update({ where: { id: task.id }, data: { assignedToPersonId: f.person.id, assignedToUserAccountId: f.account.id } }));
    expect((await pushSyncOps(ctx, stale, deps())).results[0].status).toBe("REJECTED");
    expect(await withTenant(db, f.org, tx => tx.operationIssue.count({ where: { taskId: task.id } }))).toBe(0);
  });

  it.skipIf(!url)("field issue capability is optional for old clients and changes with the authorized job grant", async () => {
    const f = await fixture(), task = await assigned(f), ctx = issueActor(f, task.id);
    const input = fieldPullInputSchema.parse({ organization_id: f.org, actor_user_id: ctx.actorId, mode: "assigned" });
    const old = await pullFieldWork(ctx, input, deps()); expect(old.tasks.find(row => row.id === task.id)).not.toHaveProperty("canReportIssue");
    const current = await pullFieldWork(ctx, { ...input, include_issue_capture: true }, deps());
    const allowed = current.tasks.find(row => row.id === task.id)!; expect(allowed.canReportIssue).toBe(true);
    const denied = await pullFieldWork(f.workerCtx, { ...input, include_issue_capture: true }, deps());
    expect(denied.tasks.find(row => row.id === task.id)).toMatchObject({ canEdit: true, canReportIssue: false });
    expect(denied.tasks.find(row => row.id === task.id)!.revision).not.toBe(allowed.revision);
  });

  it.skipIf(!url)("field issues link only verified photos created by the same worker on that task", async () => {
    const f = await fixture(), task = await assigned(f), ctx = issueActor(f, task.id), key = randomUUID();
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64");
    const image = await attachOperationEvidence(f.workerCtx, { taskId: task.id, idempotencyKey: key, note: "Photo of leaking tap", contentType: "image/png" }, bytes,
      { ...deps(), storage: { createSignedUploadUrl: () => Promise.resolve({ url: "https://storage.example.test/photo" }), createSignedDownloadUrl: () => Promise.resolve({ url: "https://storage.example.test/photo" }) },
        transport: () => Promise.resolve(new Response(null, { status: 200 })) });
    const batch = issueBatch(ctx, task.id, key);
    expect((await pushSyncOps(ctx, batch, deps())).results[0].status).toBe("APPLIED");
    expect((await pushSyncOps(ctx, batch, deps())).results[0].status).toBe("DUPLICATE");
    await withTenant(db, f.org, async tx => {
      const issue = await tx.operationIssue.findFirstOrThrow({ where: { taskId: task.id } }); expect(issue.evidenceId).toBe(image.id);
      expect(await tx.operationTaskEvidence.count({ where: { taskId: task.id } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: task.id, action: "task.issue.reported" } })).toBe(1);
    });
    const second = await assigned(f), secondCtx = issueActor(f, second.id);
    expect((await pushSyncOps(secondCtx, issueBatch(secondCtx, second.id, key), deps())).results[0]).toMatchObject({ status: "CONFLICT", error_code: "TASK_ISSUE_CONFLICT" });
    const otherKey = randomUUID(); await attachOperationEvidence(f.ctx, { taskId: task.id, idempotencyKey: otherKey, note: "Another person's photo", contentType: "image/png" }, bytes,
      { ...deps(), storage: { createSignedUploadUrl: () => Promise.resolve({ url: "https://storage.example.test/other" }), createSignedDownloadUrl: () => Promise.resolve({ url: "https://storage.example.test/other" }) }, transport: () => Promise.resolve(new Response(null, { status: 200 })) });
    expect((await pushSyncOps(ctx, issueBatch(ctx, task.id, otherKey), deps())).results[0].status).toBe("CONFLICT");
    expect((await pushSyncOps(ctx, issueBatch(ctx, task.id, randomUUID()), deps())).results[0].status).toBe("CONFLICT");
    expect(await withTenant(db, f.org, tx => tx.operationIssue.count())).toBe(1);
  });

  it.skipIf(!url)("issue evidence foreign keys reject cross-task links at the PostgreSQL boundary", async () => {
    const f = await fixture(), first = await assigned(f), second = await assigned(f);
    const evidence = await withTenant(db, f.org, tx => tx.operationTaskEvidence.create({ data: { organizationId: f.org, taskId: first.id,
      note: "Existing task evidence", createdBy: f.workerAccount.id } }));
    await expect(withTenant(db, f.org, tx => tx.operationIssue.create({ data: { organizationId: f.org, taskId: second.id,
      propertyId: f.property.id, title: "Wrong link", description: "Cannot link a different task's photo", severity: "NORMAL",
      idempotencyKey: randomUUID(), createdBy: f.workerAccount.id, evidenceId: evidence.id } }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.operationIssue.count())).toBe(0);
  });
});

function issueActor(f: Awaited<ReturnType<typeof fixture>>, taskId: string): ReservationActorContext {
  return { ...f.workerCtx, authContext: { ...f.workerCtx.authContext, permissions: new Set(["task:view", "task:edit", "issue:create"]),
    scopes: [{ organizationId: f.org, scopeType: "job", scopeId: taskId }] } };
}
function issueBatch(ctx: ReservationActorContext, taskId: string, photoClientOpId?: string): SyncPushInput {
  return parsedBatch({ organization_id: ctx.organizationId, actor_user_id: ctx.actorId, device_id: randomUUID(), op_schema_version: 1,
    ops: [{ type: "field_task.issue.report", client_op_id: randomUUID(), client_created_at: "2077-01-01T00:00:00+03:00",
      payload: { taskId, title: "Leaking tap", description: "Water is leaking under the sink", severity: "HIGH", ...(photoClientOpId ? { photoClientOpId } : {}) } }] });
}
