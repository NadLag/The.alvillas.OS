import { createHash, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { OperationRepository } from "../infrastructure/operation-repository";
import {
  canTransitionTask,
  completeChecklist,
  createTaskSchema,
  proxyCompleteTaskSchema,
  taskCommandSchema,
} from "../domain/operation-task";
import type { ReservationActorContext } from "./reservation-access";
import {
  ReservationAuthorizationError,
  ReservationConflictError,
  ReservationConfigError,
  ReservationNotFoundError,
} from "./reservation-service";
import {
  authorize,
  authorizeCollection,
  type Action,
  type Resource,
} from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { publishNotification } from "@/platform/notifications/notification-service";

export type OperationDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
  now?: Date;
};
export type OperationTask = NonNullable<
  Awaited<ReturnType<OperationRepository["task"]>>
>;
export function taskResource(task: OperationTask): Resource {
  return {
    type: "task",
    organizationId: task.organizationId,
    id: task.id,
    taskId: task.id,
    jobId: task.id,
    propertyId: task.propertyId,
    status: task.state,
    assignedUserAccountId: task.assignedToUserAccountId,
    assignedPersonId: task.assignedToPersonId,
    city: task.property.cityId ?? task.property.city,
    region: task.property.regionId ?? task.property.region,
  };
}
export function operationAllowed(
  ctx: ReservationActorContext,
  action: Action,
  resource?: Resource,
) {
  if (
    ctx.organizationId !== ctx.authContext.organizationId ||
    !(resource
      ? authorize(ctx.authContext, action, resource)
      : authorizeCollection(ctx.authContext, action, "task"))
  )
    throw new ReservationAuthorizationError();
}
export async function operationMeta(deps: OperationDeps) {
  if (deps.requestId)
    return { requestId: deps.requestId, ipAddress: deps.ipAddress ?? null };
  const h = await headers();
  return {
    requestId: h.get("x-request-id") ?? randomUUID(),
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  };
}
export function operationHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function operationAudit(
  repo: OperationRepository,
  ctx: ReservationActorContext,
  meta: Awaited<ReturnType<typeof operationMeta>>,
  action: string,
  task: OperationTask,
  before: unknown,
  reason: string,
) {
  await writeAuditEvent(repo.tx, {
    organizationId: ctx.organizationId,
    actorId: ctx.actorId,
    action,
    resourceType: "task",
    resourceId: task.id,
    propertyScopeId: task.propertyId,
    before,
    after: task,
    reason,
    ...meta,
    occurredAt: new Date(),
  });
}
export async function operationTaskDetail(
  ctx: ReservationActorContext,
  id: string,
  beforeVersion?: number,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  z.string().uuid().parse(id);
  if (beforeVersion !== undefined)
    z.number().int().positive().parse(beforeVersion);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      task = await repo.task(id);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "view", taskResource(task));
    const events = await repo.history(id, beforeVersion);
    const historicPeople = events.flatMap((event) =>
      [event.before, event.after].flatMap((snapshot) => {
        if (
          !snapshot ||
          typeof snapshot !== "object" ||
          Array.isArray(snapshot)
        )
          return [];
        return [
          "assigned_to_person_id",
          "completed_by_person_id",
          "validated_by_person_id",
        ].flatMap((key) => {
          const id = (snapshot as Record<string, unknown>)[key];
          return typeof id === "string" && z.uuid().safeParse(id).success
            ? [id]
            : [];
        });
      }),
    );
    const [people, actors] = await Promise.all([
      repo.people([
        ...new Set(
          [
            task.assignedToPersonId,
            task.completedByPersonId,
            task.validatedByPersonId,
            ...historicPeople,
          ].filter((v): v is string => Boolean(v)),
        ),
      ]),
      repo.actors(
        events.map((e) => e.actorId).filter((v): v is string => Boolean(v)),
      ),
    ]);
    const label = (person: { id: string; displayName: string }) => {
      const resource = {
        ...taskResource(task),
        type: "team_member",
        id: person.id,
      };
      // Task access and staff identity access remain separate capabilities.
      const permitted = authorize(ctx.authContext, "view", resource);
      return (
        present(
          { ...ctx.authContext, visibleDataClasses: new Set() },
          "view",
          { ...taskResource(task), data: person },
          {
            displayName: {
              dataClass: "personal",
              requiredPermission: permitted ? "team_member:view" : undefined,
            },
          },
        ).displayName ?? person.id
      );
    };
    return {
      task: present(
        { ...ctx.authContext, visibleDataClasses: new Set() },
        "view",
        { ...taskResource(task), data: task },
        {},
      ) as OperationTask,
      people: Object.fromEntries(people.map((p) => [p.id, label(p)])),
      actors: Object.fromEntries(actors.map((a) => [a.id, label(a.person)])),
      events: events.slice(0, 50),
      nextVersion: events.length > 50 ? events[49].version : null,
    };
  });
}
export async function operationCreationOptions(
  ctx: ReservationActorContext,
  propertyId?: string,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "create");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    const properties = (await repo.properties()).filter((p) =>
      authorize(ctx.authContext, "create", {
        type: "task",
        organizationId: ctx.organizationId,
        propertyId: p.id,
        city: p.cityId ?? p.city,
        region: p.regionId ?? p.region,
      }),
    );
    const selected =
      properties.find((p) => p.id === propertyId) ?? properties[0];
    return {
      properties,
      propertyId: selected?.id ?? null,
      checklists: selected
        ? ((await repo.checklists(selected.id))?.catalog.checklists.map(
            (c) => ({ key: c.key, name: c.name }),
          ) ?? [])
        : [],
    };
  });
}
export async function createOperationTask(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "create");
  const value = createTaskSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    const property = await repo.property(value.propertyId);
    if (!property) throw new ReservationNotFoundError();
    operationAllowed(ctx, "create", {
      type: "task",
      organizationId: ctx.organizationId,
      propertyId: property.id,
      city: property.cityId ?? property.city,
      region: property.regionId ?? property.region,
    });
    await repo.lock(value.idempotencyKey);
    const hash = operationHash({ operation: "create", value });
    const receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      const existing = await repo.task(receipt.taskId);
      if (!existing) throw new ReservationNotFoundError();
      return existing;
    }
    if (
      !(await repo.checklists(property.id))?.catalog.checklists.some(
        (c) => c.key === value.checklistTemplateKey,
      )
    )
      throw new ReservationConfigError();
    await repo.context(ctx.actorId, meta.requestId, value.reason);
    const row = await repo.create(value, ctx.actorId),
      task = (await repo.task(row.id))!;
    await repo.record(task.id, value.idempotencyKey, hash, ctx.actorId);
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.create",
      task,
      null,
      value.reason,
    );
    return task;
  });
}
export async function transitionOperationTask(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "edit");
  const value = taskCommandSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "edit", taskResource(task));
    const hash = operationHash({ operation: "transition", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (
        receipt.taskId !== task.id ||
        receipt.createdBy !== ctx.actorId ||
        receipt.payloadHash !== hash
      )
        throw new ReservationConflictError();
      return task;
    }
    if (
      task.version !== value.expectedVersion ||
      !canTransitionTask(task.state, value.state) ||
      ["ASSIGNED", "COMPLETED"].includes(value.state)
    )
      throw new ReservationConflictError();
    if (value.state === "IN_PROGRESS" && !task.assignedToPersonId)
      throw new ReservationConflictError();
    await repo.context(ctx.actorId, meta.requestId, value.reason);
    await repo.update(task.id, { state: value.state });
    const after = (await repo.task(task.id))!;
    await repo.record(task.id, value.idempotencyKey, hash, ctx.actorId);
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.state.changed",
      after,
      task,
      value.reason,
    );
    return after;
  });
}
export async function proxyCompleteOperationTask(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "validate");
  const value = proxyCompleteTaskSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "validate", taskResource(task));
    const hash = operationHash({ operation: "proxy", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (
        receipt.taskId !== task.id ||
        receipt.createdBy !== ctx.actorId ||
        receipt.payloadHash !== hash
      )
        throw new ReservationConflictError();
      return task;
    }
    if (
      task.version !== value.expectedVersion ||
      !["ASSIGNED", "IN_PROGRESS"].includes(task.state) ||
      task.assignedToPersonId !== value.performedByPersonId ||
      value.performedByPersonId === ctx.personId ||
      task.assignedToUserAccountId === ctx.actorId ||
      !completeChecklist(task.checklistItems, value.checklistItemIds)
    )
      throw new ReservationConflictError();
    if (!(await repo.performer(value.performedByPersonId)))
      throw new ReservationNotFoundError();
    const now = deps.now ?? new Date();
    await repo.context(ctx.actorId, meta.requestId, value.reason);
    if (task.state === "ASSIGNED")
      await repo.update(task.id, { state: "IN_PROGRESS" });
    await repo.completeItems(
      task.id,
      {
        personId: value.performedByPersonId,
        userAccountId: task.assignedToUserAccountId,
      },
      now,
    );
    await repo.update(task.id, {
      state: "COMPLETED",
      completedAt: now,
      completedByPersonId: value.performedByPersonId,
      completedByUserAccountId: task.assignedToUserAccountId,
      validatedByPersonId: ctx.personId,
      validatedByUserAccountId: ctx.actorId,
      validationReason: value.reason,
      validatedAt: now,
      completionSource: "PROXY",
      completionIdempotencyKey: value.idempotencyKey,
    });
    const after = (await repo.task(task.id))!;
    await repo.record(task.id, value.idempotencyKey, hash, ctx.actorId);
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.proxy_validation.created",
      after,
      task,
      value.reason,
    );
    if (task.assignedToUserAccountId)
      await publishNotification(
        tx,
        ctx.organizationId,
        {
          kind: "task_completed",
          recipientId: task.assignedToUserAccountId,
          targetId: task.id,
        },
        `notification:task:${task.id}:completed`,
      );
    return after;
  });
}
