import { initializeReservationHistory } from "./reservation-history";
import { OperationRepository } from "../infrastructure/operation-repository";
import { completeChecklist } from "../domain/operation-task";
import { assignTaskInTransaction } from "./operation-scheduling";
import { taskResource } from "./operation-service";
import { headers } from "next/headers";
import { publishNotification } from "@/platform/notifications/notification-service";
import {
  manualReservationInputSchema,
  completeTaskInputSchema,
  type CompleteTaskInput,
  type FieldTaskSummary,
  type ManualReservationInput,
  type ManualReservationResult,
  type OperationTaskSummary,
  type ReservationSummary
} from "@/modules/reservations/domain/reservation-task";
import { ReservationRepository } from "@/modules/reservations/infrastructure/reservation-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, authorizeCollection } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";

export class ReservationAuthorizationError extends Error {
  constructor(message = "Reservation action is not authorized") {
    super(message);
    this.name = "ReservationAuthorizationError";
  }
}

export class ReservationNotFoundError extends Error {
  constructor(message = "Reservation resource was not found") {
    super(message);
    this.name = "ReservationNotFoundError";
  }
}

export class ReservationConfigError extends Error {
  constructor(message = "Reservation task configuration is missing or invalid") {
    super(message);
    this.name = "ReservationConfigError";
  }
}

export class ReservationConflictError extends Error {
  constructor(message = "Reservation task cannot be completed") {
    super(message);
    this.name = "ReservationConflictError";
  }
}

type ReservationServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

export type ReservationAuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function assertAllowed(
  ctx: ReservationActorContext,
  action: "view" | "create" | "edit",
  resource: "reservation" | "task" | "guest"
): void {
  if (ctx.organizationId !== ctx.authContext.organizationId) throw new ReservationAuthorizationError();
  const allowed = authorizeCollection(ctx.authContext, action, resource);

  if (!allowed) {
    throw new ReservationAuthorizationError();
  }
}

async function auditMeta(deps: ReservationServiceDeps): Promise<ReservationAuditMeta> {
  if (deps.requestId) {
    return {
      requestId: deps.requestId,
      ipAddress: deps.ipAddress ?? null
    };
  }

  const requestHeaders = await headers();

  return {
    requestId: requestHeaders.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  };
}

function db(deps: ReservationServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

export function parseManualReservationInput(input: unknown) {
  return manualReservationInputSchema.safeParse(input);
}

export function parseCompleteTaskInput(input: unknown) {
  return completeTaskInputSchema.safeParse(input);
}

async function auditReservationCreate(
  tx: Parameters<typeof writeAuditEvent>[0],
  ctx: ReservationActorContext,
  meta: ReservationAuditMeta,
  reservation: ReservationSummary
): Promise<void> {
  await writeAuditEvent(tx, {
    organizationId: ctx.organizationId,
    actorId: ctx.actorId,
    action: "reservation.create",
    resourceType: "reservation",
    resourceId: reservation.id,
    ipAddress: meta.ipAddress,
    propertyScopeId: reservation.propertyId,
    after: reservation,
    reason: "S3 manual reservation",
    requestId: meta.requestId,
    occurredAt: new Date()
  });
}

async function auditTaskCreate(
  tx: Parameters<typeof writeAuditEvent>[0],
  ctx: ReservationActorContext,
  meta: ReservationAuditMeta,
  task: OperationTaskSummary,
  propertyId: string
): Promise<void> {
  await writeAuditEvent(tx, {
    organizationId: ctx.organizationId,
    actorId: ctx.actorId,
    action: "task.create",
    resourceType: "task",
    resourceId: task.id,
    ipAddress: meta.ipAddress,
    propertyScopeId: propertyId,
    after: task,
    reason: "S3 reservation workflow generation",
    requestId: meta.requestId,
    occurredAt: new Date()
  });
}

export async function createManualReservation(
  ctx: ReservationActorContext,
  input: ManualReservationInput,
  deps: ReservationServiceDeps = {}
): Promise<ManualReservationResult> {
  assertAllowed(ctx, "create", "reservation");
  assertAllowed(ctx, "create", "task");
  assertAllowed(ctx, "create", "guest");
  const meta = await auditMeta(deps);

  const parsed = manualReservationInputSchema.parse(input);
  return withTenant(db(deps), ctx.organizationId, tx => createManualReservationInTransaction(ctx, parsed, tx, meta));
}

export async function createManualReservationInTransaction(ctx: ReservationActorContext, input: ManualReservationInput, tx: TenantTransaction, meta: ReservationAuditMeta, status = "CONFIRMED"): Promise<ManualReservationResult> {
  assertAllowed(ctx, "create", "reservation");
  assertAllowed(ctx, "create", "task");
  assertAllowed(ctx, "create", "guest");

    const repository = new ReservationRepository(tx, ctx.organizationId);
    await repository.lockProperty(input.propertyId);
    const existing = await repository.findReservationByIdempotency(input.idempotencyKey);

    if (existing) {
      if (existing.propertyId !== input.propertyId) throw new ReservationConflictError();
      for (const type of ["reservation", "guest", "task"]) if (!authorize(ctx.authContext, "create", { type, organizationId: ctx.organizationId, propertyId: existing.propertyId, reservationId: existing.id, id: existing.id, city: existing.city, region: existing.region })) throw new ReservationAuthorizationError();
      if (existing.source !== input.source || existing.guestName !== input.guestName || existing.checkIn.toISOString().slice(0, 10) !== input.checkIn || existing.checkOut.toISOString().slice(0, 10) !== input.checkOut) throw new ReservationConflictError("Idempotency key reused for a different booking");
      return {
        reservation: existing,
        tasks: await repository.tasksForReservation(existing.id),
        conflictCount: existing.conflictCount,
        idempotent: true
      };
    }

    const property = await repository.findProperty(input.propertyId);

    if (!property) {
      throw new ReservationNotFoundError("Property does not exist in this tenant");
    }

    if (!authorize(ctx.authContext, "create", { type: "guest", organizationId: ctx.organizationId, propertyId: property.id, city: property.cityId ?? property.city, region: property.regionId ?? property.region })) {
      throw new ReservationAuthorizationError();
    }

    if (
      !authorize(ctx.authContext, "create", {
        type: "reservation",
        organizationId: ctx.organizationId,
        propertyId: property.id, city: property.cityId ?? property.city, region: property.regionId ?? property.region
      }) ||
      !authorize(ctx.authContext, "create", {
        type: "task",
        organizationId: ctx.organizationId,
        propertyId: property.id, city: property.cityId ?? property.city, region: property.regionId ?? property.region
      })
    ) {
      throw new ReservationAuthorizationError();
    }

    if (input.externalId && await repository.sourceMatch(input.propertyId, { source: input.source, externalId: input.externalId } as never)) throw new ReservationConflictError("Duplicate source identity");
    if (input.quote && !authorize(ctx.authContext, "create", { type: "financial_transaction", organizationId: ctx.organizationId, propertyId: input.propertyId, city: property.cityId ?? property.city, region: property.regionId ?? property.region, dataClass: "financial" })) throw new ReservationAuthorizationError();
    const reference = await nextReferenceNumber(tx, ctx.organizationId, "RES", 4);
    const reservation = await repository.createReservation(input, reference, ctx.actorId, status);
    await initializeReservationHistory(tx, ctx, reservation, { guestName: input.guestName || null, guestEmail: input.guestEmail ?? null, guestPhone: input.guestPhone ?? null }, meta, input.quote ?? null);
    if (status === "IMPORTED") return { reservation, tasks: [], conflictCount: 0, idempotent: false };
    const taskConfig = await repository.resolveTaskConfig({
      propertyId: reservation.propertyId,
      asOf: reservation.createdAt
    });

    if (!taskConfig) {
      throw new ReservationConfigError();
    }

    await repository.snapshotTaskConfigRule({
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      rule: taskConfig.rule,
      resolvedAt: reservation.createdAt,
      createdBy: ctx.actorId
    });
    for (const rule of taskConfig.supportingRules ?? []) {
      await repository.snapshotTaskConfigRule({ reservationId: reservation.id, propertyId: reservation.propertyId,
        rule, resolvedAt: reservation.createdAt, createdBy: ctx.actorId });
    }
    await auditReservationCreate(tx, ctx, meta, reservation);
    await publishNotification(tx, ctx.organizationId, { kind: "reservation_created", recipientId: ctx.actorId, targetId: reservation.id }, `notification:reservation:${reservation.id}:created`);

    const overlaps = await repository.listOverlaps(input, reservation.id);
    for (const overlap of overlaps) {
      const conflict = await repository.createConflict(reservation, overlap, ctx.actorId);
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        action: "reservation.conflict.detected",
        resourceType: "reservation_conflict",
        resourceId: conflict.id,
        ipAddress: meta.ipAddress,
        propertyScopeId: reservation.propertyId,
        after: {
          reservationId: reservation.id,
          conflictingReservationId: overlap.id,
          reason: "OVERLAPPING_CONFIRMED_RESERVATION"
        },
        reason: "S3 overlap detection",
        requestId: meta.requestId,
        occurredAt: new Date()
      });
    }

    const tasks: OperationTaskSummary[] = [];
    for (const template of taskConfig.config.tasks) {
      const result = await repository.ensureTask(reservation, template, {
        userAccountId: ctx.actorId,
        personId: ctx.personId
      });
      tasks.push(result.task);
      if (result.created) {
        const operations = new OperationRepository(tx, ctx.organizationId), full = (await operations.task(result.task.id))!;
        if (authorize(ctx.authContext, "assign", taskResource(full))) {
          const policy = await operations.policy(full.propertyId);
          await assignTaskInTransaction(operations, ctx, full, null, policy.types[full.type]?.start_minute??policy.shift_start_minute, meta, "Configured reservation task assignment");
          tasks[tasks.length - 1] = (await repository.tasksForReservation(reservation.id)).find(t => t.id === full.id)!;
        }
        await auditTaskCreate(tx, ctx, meta, result.task, reservation.propertyId);
        if (result.task.assignedToUserAccountId) await publishNotification(tx, ctx.organizationId, {
          kind: "task_assigned", recipientId: result.task.assignedToUserAccountId, targetId: result.task.id
        }, `notification:task:${result.task.id}:assigned`);
      }
    }

    await repository.refreshConflicts(reservation.propertyId, ctx.actorId);
    return {
      reservation: {
        ...reservation,
        conflictCount: overlaps.length
      },
      tasks,
      conflictCount: overlaps.length,
      idempotent: false
    };
}

export async function listReservations(
  ctx: ReservationActorContext,
  deps: ReservationServiceDeps = {}
): Promise<ReservationSummary[]> {
  assertAllowed(ctx, "view", "reservation");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ReservationRepository(tx, ctx.organizationId);
    const properties = (await repository.listPropertyOptions()).filter(property => authorize(ctx.authContext, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: property.id, city: property.cityId ?? property.city, region: property.regionId ?? property.region }));
    return (await repository.listReservations(properties.map(property => property.id))).filter((reservation) =>
      authorize(ctx.authContext, "view", {
        type: "reservation",
        organizationId: ctx.organizationId,
        id: reservation.id,
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        status: reservation.status, city: reservation.city, region: reservation.region
      })
    ).map(reservation => present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { type: "reservation", organizationId: ctx.organizationId, propertyId: reservation.propertyId, reservationId: reservation.id, id: reservation.id, status: reservation.status, city: reservation.city, region: reservation.region, data: reservation }, { guestName: { dataClass: "guest", requiredPermission: authorize(ctx.authContext, "view", { type: "guest", organizationId: ctx.organizationId, propertyId: reservation.propertyId }) ? "guest:view" : undefined } }) as ReservationSummary);
  });
}

export async function listReservationPropertyOptions(
  ctx: ReservationActorContext,
  deps: ReservationServiceDeps = {}
): Promise<Array<{ id: string; name: string; city: string }>> {
  assertAllowed(ctx, "create", "reservation");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new ReservationRepository(tx, ctx.organizationId).listPropertyOptions()).filter((property) =>
      authorize(ctx.authContext, "create", {
        type: "reservation",
        organizationId: ctx.organizationId,
        propertyId: property.id,
        city: property.city
      })
    )
  );
}

export async function listOperationTasks(
  ctx: ReservationActorContext,
  deps: ReservationServiceDeps = {}
): Promise<OperationTaskSummary[]> {
  assertAllowed(ctx, "view", "task");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new ReservationRepository(tx, ctx.organizationId).listTasks()).filter((task) =>
      authorize(ctx.authContext, "view", {
        type: "task",
        organizationId: ctx.organizationId,
        id: task.id,
        taskId: task.id,
        jobId: task.id,
        propertyId: task.propertyId,
        city: task.city,
        region: task.region,
        status: task.state,
        assignedUserAccountId: task.assignedToUserAccountId
      })
    )
  );
}

export async function listAssignedFieldTasks(
  ctx: ReservationActorContext,
  deps: ReservationServiceDeps = {}
): Promise<FieldTaskSummary[]> {
  assertAllowed(ctx, "view", "task");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new ReservationRepository(tx, ctx.organizationId).listFieldTasks(ctx.actorId)).filter(task => authorize(ctx.authContext, "view", {
      type: "task", organizationId: ctx.organizationId, id: task.id, taskId: task.id, jobId: task.id, propertyId: task.propertyId,
      city: task.city, region: task.region, status: task.state, assignedUserAccountId: task.assignedToUserAccountId, assignedPersonId: task.assignedToPersonId
    }))
  );
}

export async function getAssignedFieldTask(
  ctx: ReservationActorContext,
  taskId: string,
  deps: ReservationServiceDeps = {}
): Promise<FieldTaskSummary> {
  assertAllowed(ctx, "view", "task");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const task = await new ReservationRepository(tx, ctx.organizationId).findAssignedFieldTask(
      taskId,
      ctx.actorId
    );

    if (!task) {
      throw new ReservationNotFoundError("Task is not assigned to this worker");
    }

    if (!authorize(ctx.authContext, "view", { type: "task", organizationId: ctx.organizationId, id: task.id, taskId: task.id, jobId: task.id, propertyId: task.propertyId, city: task.city, region: task.region, status: task.state, assignedUserAccountId: task.assignedToUserAccountId, assignedPersonId: task.assignedToPersonId })) throw new ReservationNotFoundError();

    return task;
  });
}

export async function completeAssignedFieldTask(
  ctx: ReservationActorContext,
  input: CompleteTaskInput,
  deps: ReservationServiceDeps = {}
): Promise<FieldTaskSummary> {
  assertAllowed(ctx, "edit", "task");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    completeAssignedFieldTaskInTransaction(ctx, input, tx, meta)
  );
}

export async function completeAssignedFieldTaskInTransaction(
  ctx: ReservationActorContext,
  input: CompleteTaskInput,
  tx: TenantTransaction,
  meta: ReservationAuditMeta,
  completionSource: "SELF" | "OFFLINE_SYNC" = "SELF"
): Promise<FieldTaskSummary> {
  assertAllowed(ctx, "edit", "task");

  const operations = new OperationRepository(tx, ctx.organizationId);
  await operations.lock(input.taskId);
  const parsed = completeTaskInputSchema.parse(input);
  await operations.lock(parsed.idempotencyKey);
  const repository = new ReservationRepository(tx, ctx.organizationId);
  const before = await repository.findAssignedFieldTask(input.taskId, ctx.actorId);

  if (!before) {
    throw new ReservationNotFoundError("Task is not assigned to this worker");
  }

  const fullTask = (await operations.task(before.id))!;
  if (!authorize(ctx.authContext, "edit", { type: "task", organizationId: ctx.organizationId, id: before.id, taskId: before.id, jobId: before.id, propertyId: before.propertyId, city: fullTask.property.cityId ?? fullTask.property.city, region: fullTask.property.regionId ?? fullTask.property.region, status: before.state, assignedUserAccountId: before.assignedToUserAccountId, assignedPersonId: fullTask.assignedToPersonId })) throw new ReservationAuthorizationError();

  if (before.state === "COMPLETED") {
    if (before.completedByUserAccountId === ctx.actorId) {
      return before;
    }

    throw new ReservationConflictError("Task was already completed by another worker");
  }

  if (!["PLANNED", "ASSIGNED", "IN_PROGRESS"].includes(before.state)) throw new ReservationConflictError();

  const checklistItemIds = new Set(input.checklistItemIds);
  const hasAllChecklistItems = completeChecklist(before.checklistItems, input.checklistItemIds);

  if (!hasAllChecklistItems) {
    throw new ReservationConflictError("All checklist items must be completed before finishing");
  }

  await operations.context(ctx.actorId, meta.requestId, input.note ?? "Assigned worker completion");
  if (before.state === "PLANNED") await operations.update(before.id, { state: "ASSIGNED" });
  if (before.state !== "IN_PROGRESS") await operations.update(before.id, { state: "IN_PROGRESS" });
  const completed = await repository.completeFieldTask(
    before,
    [...checklistItemIds],
    {
      userAccountId: ctx.actorId,
      personId: ctx.personId
    },
    input.idempotencyKey,
    completionSource
  );

  await writeAuditEvent(tx, {
    organizationId: ctx.organizationId,
    actorId: ctx.actorId,
    action: "task.complete",
    resourceType: "task",
    resourceId: completed.id,
    ipAddress: meta.ipAddress,
    propertyScopeId: completed.propertyId,
    before,
    after: {
      ...completed,
      performedByUserAccountId: ctx.actorId,
      performedByPersonId: ctx.personId,
      completedChecklistItemIds: [...checklistItemIds],
      completionIdempotencyKey: input.idempotencyKey
    },
    reason: input.note ?? "S4 field task completion",
    requestId: meta.requestId,
    occurredAt: new Date()
  });

  await publishNotification(tx, ctx.organizationId, { kind: "task_completed", recipientId: ctx.actorId, targetId: completed.id }, `notification:task:${completed.id}:completed`);
  await operations.event("TaskCompleted",completed.id,completed.propertyId,`task:${completed.id}:completed:${input.idempotencyKey}`);
  return completed;
}
