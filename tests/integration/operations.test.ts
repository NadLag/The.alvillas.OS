import { provisionIntegrationRole } from "./support/database-role";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { permissionCatalog } from "@/platform/authz/catalog";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import {
  createOperationTask,
  operationTaskDetail,
  proxyCompleteOperationTask,
  transitionOperationTask,
} from "@/modules/reservations/application/operation-service";
import {
  completeAssignedFieldTask,
  ReservationAuthorizationError,
  ReservationConflictError,
  ReservationNotFoundError,
} from "@/modules/reservations/application/reservation-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
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
    const moved = await rescheduleOperationTask(
      f.ctx,
      {
        taskId: first.id,
        expectedVersion: first.version,
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
});
