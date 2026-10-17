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
  resource: "reservation" | "task",
  id?: string
): void {
  const allowed = id
    ? authorize(ctx.authContext, action, {
        type: resource,
        organizationId: ctx.organizationId,
        id,
        reservationId: resource === "reservation" ? id : undefined,
        taskId: resource === "task" ? id : undefined,
        jobId: resource === "task" ? id : undefined
      })
    : authorizeCollection(ctx.authContext, action, resource);

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
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new ReservationRepository(tx, ctx.organizationId);
    const existing = await repository.findReservationByIdempotency(input.idempotencyKey);

    if (existing) {
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

    if (input.guestPhone && !authorize(ctx.authContext, "create", { type: "guest", organizationId: ctx.organizationId, propertyId: property.id })) {
      throw new ReservationAuthorizationError();
    }

    if (
      !authorize(ctx.authContext, "create", {
        type: "reservation",
        organizationId: ctx.organizationId,
        propertyId: property.id
      }) ||
      !authorize(ctx.authContext, "create", {
        type: "task",
        organizationId: ctx.organizationId,
        propertyId: property.id
      })
    ) {
      throw new ReservationAuthorizationError();
    }

    const reference = await nextReferenceNumber(tx, ctx.organizationId, "RES", 4);
    const reservation = await repository.createReservation(input, reference, ctx.actorId);
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
        await auditTaskCreate(tx, ctx, meta, result.task, reservation.propertyId);
        if (result.task.assignedToUserAccountId) await publishNotification(tx, ctx.organizationId, {
          kind: "task_assigned", recipientId: result.task.assignedToUserAccountId, targetId: result.task.id
        }, `notification:task:${result.task.id}:assigned`);
      }
    }

    return {
      reservation: {
        ...reservation,
        conflictCount: overlaps.length
      },
      tasks,
      conflictCount: overlaps.length,
      idempotent: false
    };
  });
}

export async function listReservations(
  ctx: ReservationActorContext,
  deps: ReservationServiceDeps = {}
): Promise<ReservationSummary[]> {
  assertAllowed(ctx, "view", "reservation");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new ReservationRepository(tx, ctx.organizationId).listReservations()).filter((reservation) =>
      authorize(ctx.authContext, "view", {
        type: "reservation",
        organizationId: ctx.organizationId,
        id: reservation.id,
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        status: reservation.status
      })
    )
  );
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
    new ReservationRepository(tx, ctx.organizationId).listFieldTasks(ctx.actorId)
  );
}

export async function getAssignedFieldTask(
  ctx: ReservationActorContext,
  taskId: string,
  deps: ReservationServiceDeps = {}
): Promise<FieldTaskSummary> {
  assertAllowed(ctx, "view", "task", taskId);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const task = await new ReservationRepository(tx, ctx.organizationId).findAssignedFieldTask(
      taskId,
      ctx.actorId
    );

    if (!task) {
      throw new ReservationNotFoundError("Task is not assigned to this worker");
    }

    return task;
  });
}

export async function completeAssignedFieldTask(
  ctx: ReservationActorContext,
  input: CompleteTaskInput,
  deps: ReservationServiceDeps = {}
): Promise<FieldTaskSummary> {
  assertAllowed(ctx, "edit", "task", input.taskId);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    completeAssignedFieldTaskInTransaction(ctx, input, tx, meta)
  );
}

export async function completeAssignedFieldTaskInTransaction(
  ctx: ReservationActorContext,
  input: CompleteTaskInput,
  tx: TenantTransaction,
  meta: ReservationAuditMeta
): Promise<FieldTaskSummary> {
  assertAllowed(ctx, "edit", "task", input.taskId);

  const repository = new ReservationRepository(tx, ctx.organizationId);
  const before = await repository.findAssignedFieldTask(input.taskId, ctx.actorId);

  if (!before) {
    throw new ReservationNotFoundError("Task is not assigned to this worker");
  }

  if (before.state === "COMPLETED") {
    if (before.completedByUserAccountId === ctx.actorId) {
      return before;
    }

    throw new ReservationConflictError("Task was already completed by another worker");
  }

  const checklistItemIds = new Set(input.checklistItemIds);
  const hasAllChecklistItems =
    checklistItemIds.size === before.checklistItems.length &&
    before.checklistItems.every((item) => checklistItemIds.has(item.id));

  if (!hasAllChecklistItems) {
    throw new ReservationConflictError("All checklist items must be completed before finishing");
  }

  const completed = await repository.completeFieldTask(
    before,
    [...checklistItemIds],
    {
      userAccountId: ctx.actorId,
      personId: ctx.personId
    },
    input.idempotencyKey
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
  return completed;
}
