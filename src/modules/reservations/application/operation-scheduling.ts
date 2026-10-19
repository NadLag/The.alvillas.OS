import { z } from "zod";
import { OperationRepository } from "../infrastructure/operation-repository";
import {
  assignmentCommandSchema,
  propertyInstant,
  propertyMinute,
  rescheduleTaskSchema,
  swapTaskSchema,
  terminalTaskStates,
} from "../domain/operation-task";
import { dateToUtc } from "../domain/reservation-task";
import { localDate } from "../domain/reservation";
import type { ReservationActorContext } from "./reservation-access";
import {
  operationScope,
  operationAllowed,
  operationAudit,
  operationHash,
  operationMeta,
  taskResource,
  type OperationTask,
  type OperationDeps,
} from "./operation-service";
import {
  ReservationConflictError,
  ReservationNotFoundError,
} from "./reservation-service";
import { authorize } from "@/platform/authz/authorize";
import { contextForRoleAssignments } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { publishNotification } from "@/platform/notifications/notification-service";

export async function taskCandidates(
  repo: OperationRepository,
  task: OperationTask,
  date: string,
  minute: number,
  excluded: string[] = [task.id],
) {
  const policy = await repo.policy(task.propertyId),
    settings = policy.types[task.type];
  if (!settings)
    throw new ReservationConflictError("operation_type_policy_missing");
  const start = propertyInstant(date, minute, task.property.timezone),
    end = new Date(start.getTime() + settings.duration_minutes * 60000);
  const roles = await repo.team(),
    grouped = new Map<string, typeof roles>();
  for (const row of roles) {
    if (
      !settings.role_keys.includes(row.role.key) ||
      row.validFrom > start ||
      (row.validTo && row.validTo < end) ||
      (row.userAccount && row.userAccount.status !== "ACTIVE")
    )
      continue;
    const resource = {
      ...taskResource(task),
      status: "ASSIGNED",
      assignedPersonId: row.personId,
      assignedUserAccountId: row.userAccountId,
      occurredAt: start,
    };
    const ctx = {
      ...contextForRoleAssignments(
        repo.organizationId,
        row.userAccountId ?? "",
        [row],
      ),
      personId: row.personId,
    };
    if (
      !authorize(ctx, "view", resource, start) ||
      !authorize(ctx, "edit", resource, start)
    )
      continue;
    const rows = grouped.get(row.personId) ?? [];
    rows.push(row);
    grouped.set(row.personId, rows);
  }
  const dateUtc = dateToUtc(date),
    from = new Date(dateUtc.getTime() - 86400000),
    until = new Date(dateUtc.getTime() + 86400000);
  const [availability, tasks] = await Promise.all([
    repo.availability([...grouped.keys()], dateUtc, dateUtc),
    repo.workloads(from, until, excluded),
  ]);
  const people = [...grouped]
    .map(([personId, rows]) => {
      rows.sort(
        (a, b) =>
          settings.role_keys.indexOf(a.role.key) -
            settings.role_keys.indexOf(b.role.key) || a.id.localeCompare(b.id),
      );
      const row = rows[0];
      const jobs = tasks.filter((t) => t.assignedToPersonId === personId);
      const workload = jobs.filter((t) =>
        t.scheduledStart
          ? localDate(t.scheduledStart, task.property.timezone) === date
          : t.dueDate.getTime() === dateUtc.getTime(),
      ).length;
      const unavailable = availability.some(
        (a) =>
          a.personId === personId && ["LEAVE", "UNAVAILABLE"].includes(a.kind),
      );
      const overlap = jobs.some((t) => {
        const a =
            t.scheduledStart ??
            propertyInstant(
              t.dueDate.toISOString().slice(0, 10),
              policy.shift_start_minute,
              t.property.timezone,
            ),
          b =
            t.scheduledEnd ??
            new Date(a.getTime() + settings.duration_minutes * 60000);
        return a < end && b > start;
      });
      const conflict = unavailable
        ? "UNAVAILABLE"
        : overlap
          ? "OVERLAP"
          : workload >= settings.max_daily_tasks
            ? "CAPACITY"
            : null;
      const preferred = settings.preferred_people.indexOf(personId),
        fallback = settings.fallback_people.indexOf(personId);
      return {
        personId,
        userAccountId: row.userAccountId,
        name: row.person.displayName,
        roleKey: row.role.key,
        workload,
        conflict,
        rank:
          preferred >= 0
            ? preferred
            : fallback >= 0
              ? settings.preferred_people.length + fallback
              : settings.preferred_people.length +
                settings.fallback_people.length +
                1,
      };
    })
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.workload - b.workload ||
        a.personId.localeCompare(b.personId),
    );
  return { people, start, end, policy };
}
export async function assignTaskInTransaction(
  repo: OperationRepository,
  ctx: ReservationActorContext,
  task: OperationTask,
  personId: string | null,
  minute: number,
  meta: Awaited<ReturnType<typeof operationMeta>>,
  reason: string,
  automatic = false,
) {
  if (!automatic) operationAllowed(ctx, "assign", taskResource(task));
  if (terminalTaskStates.includes(task.state) || task.state === "IN_PROGRESS")
    throw new ReservationConflictError();
  // All assignments and swaps serialize per tenant, preventing write skew across properties.
  await repo.lock("crew-schedule");
  const options = await taskCandidates(
    repo,
    task,
    task.dueDate.toISOString().slice(0, 10),
    minute,
  );
  const candidate = personId
    ? options.people.find((p) => p.personId === personId)
    : options.people.find((p) => !p.conflict);
  if (personId && (!candidate || candidate.conflict))
    throw new ReservationConflictError("operation_assignment_conflict");
  await repo.context(ctx.actorId, meta.requestId, reason);
  await repo.update(task.id, {
    assignedToPersonId: candidate?.personId ?? null,
    assignedToUserAccountId: candidate?.userAccountId ?? null,
    requiredRoleKey:
      candidate?.roleKey ?? options.policy.types[task.type].role_keys[0],
    scheduledStart: options.start,
    scheduledEnd: options.end,
    state:
      task.state === "BLOCKED" ? "BLOCKED" : candidate ? "ASSIGNED" : "PLANNED",
  });
  const after = (await repo.task(task.id))!;
  await operationAudit(repo, ctx, meta, "task.assigned", after, task, reason);
  if (candidate?.userAccountId)
    await publishNotification(
      repo.tx,
      ctx.organizationId,
      {
        kind: "task_assigned",
        recipientId: candidate.userAccountId,
        targetId: task.id,
      },
      `task:${task.id}:assigned:${after.version}`,
    );
  return after;
}
export async function operationAssignmentOptions(
  ctx: ReservationActorContext,
  taskId: string,
  deps: OperationDeps = {},
  search = "",
) {
  operationAllowed(ctx, "assign");
  z.uuid().parse(taskId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      task = await repo.task(taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "assign", taskResource(task));
    const policy = await repo.policy(task.propertyId);
    const minute = task.scheduledStart
      ? propertyMinute(task.scheduledStart, task.property.timezone)
      : policy.shift_start_minute;
    const options = await taskCandidates(
      repo,
      task,
      task.dueDate.toISOString().slice(0, 10),
      minute,
    );
    z.string().max(120).parse(search);
    const properties = await repo.properties();
    const [assignScope, viewScope] = await Promise.all([
      operationScope(ctx, "assign", repo, properties),
      operationScope(ctx, "view", repo, properties),
    ]);
    const swapTasks = (
      await repo.page(
        {
          AND: [{ OR: assignScope.groups }, { OR: viewScope.groups }],
          state: "ASSIGNED",
          assignedToPersonId: { not: null },
          id: { not: task.id },
          ...(search
            ? {
                OR: ["en", "fr", "ar"].map((locale) => ({
                  titleTranslations: {
                    path: [locale],
                    string_contains: search,
                  },
                })),
              }
            : {}),
        },
        0,
        200,
      )
    )
      .filter(
        (t) =>
          authorize(ctx.authContext, "assign", taskResource(t)) &&
          authorize(ctx.authContext, "view", taskResource(t)),
      )
      .map((t) => ({
        id: t.id,
        title: t.titleTranslations,
        propertyName: t.property.name,
        version: t.version,
      }));
    return {
      minute,
      swapTasks,
      people: options.people.map((p) => {
        const canName = authorize(ctx.authContext, "view", {
          ...taskResource(task),
          type: "team_member",
          id: p.personId,
        });
        const named = present(
          { ...ctx.authContext, visibleDataClasses: new Set() },
          "assign",
          { ...taskResource(task), data: { name: p.name } },
          {
            name: {
              dataClass: "personal",
              requiredPermission: canName ? "team_member:view" : undefined,
            },
          },
        );
        return { ...p, name: named.name ?? p.personId };
      }),
    };
  });
}
export async function assignOperationTask(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "assign");
  const value = assignmentCommandSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "assign", taskResource(task));
    const hash = operationHash({ operation: "assign", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      return task;
    }
    if (task.version !== value.expectedVersion)
      throw new ReservationConflictError();
    const after = await assignTaskInTransaction(
      repo,
      ctx,
      task,
      value.personId,
      value.startMinute,
      meta,
      value.reason,
    );
    await repo.record(task.id, value.idempotencyKey, hash, ctx.actorId);
    return after;
  });
}
export async function rescheduleOperationTask(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "edit");
  const value = rescheduleTaskSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "edit", taskResource(task));
    const hash = operationHash({ operation: "reschedule", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      return task;
    }
    if (
      task.version !== value.expectedVersion ||
      terminalTaskStates.includes(task.state) ||
      task.state === "IN_PROGRESS"
    )
      throw new ReservationConflictError();
    const options = await taskCandidates(
      repo,
      task,
      value.dueDate,
      value.startMinute,
    );
    if (
      task.assignedToPersonId &&
      !options.people.some(
        (p) => p.personId === task.assignedToPersonId && !p.conflict,
      )
    )
      throw new ReservationConflictError();
    await repo.context(ctx.actorId, meta.requestId, value.reason);
    await repo.update(task.id, {
      dueDate: dateToUtc(value.dueDate),
      scheduledStart: options.start,
      scheduledEnd: options.end,
    });
    const after = (await repo.task(task.id))!;
    await repo.record(task.id, value.idempotencyKey, hash, ctx.actorId);
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.rescheduled",
      after,
      task,
      value.reason,
    );
    return after;
  });
}
export async function swapOperationTasks(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "assign");
  const value = swapTaskSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    for (const id of [value.taskId, value.otherTaskId].sort())
      await repo.lock(id);
    await repo.lock(value.idempotencyKey);
    const [a, b] = await Promise.all([
      repo.task(value.taskId),
      repo.task(value.otherTaskId),
    ]);
    if (!a || !b) throw new ReservationNotFoundError();
    for (const task of [a, b])
      operationAllowed(ctx, "assign", taskResource(task));
    const hash = operationHash({ operation: "swap", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      return [a, b];
    }
    if (
      a.version !== value.expectedVersion ||
      b.version !== value.otherVersion ||
      !a.assignedToPersonId ||
      !b.assignedToPersonId ||
      a.assignedToPersonId === b.assignedToPersonId ||
      [a, b].some(
        (t) =>
          terminalTaskStates.includes(t.state) || t.state === "IN_PROGRESS",
      )
    )
      throw new ReservationConflictError();
    for (const [task, other] of [
      [a, b],
      [b, a],
    ]) {
      const policy = await repo.policy(task.propertyId);
      const minute = task.scheduledStart
        ? propertyMinute(task.scheduledStart, task.property.timezone)
        : policy.shift_start_minute;
      const options = await taskCandidates(
        repo,
        task,
        task.dueDate.toISOString().slice(0, 10),
        minute,
        [a.id, b.id],
      );
      const candidate = options.people.find(
        (p) => p.personId === other.assignedToPersonId && !p.conflict,
      );
      if (!candidate) throw new ReservationConflictError();
      await repo.context(ctx.actorId, meta.requestId, value.reason);
      await repo.update(task.id, {
        assignedToPersonId: candidate.personId,
        assignedToUserAccountId: candidate.userAccountId,
        requiredRoleKey: candidate.roleKey,
        scheduledStart: options.start,
        scheduledEnd: options.end,
      });
      await operationAudit(
        repo,
        ctx,
        meta,
        "task.assignment.swapped",
        (await repo.task(task.id))!,
        task,
        value.reason,
      );
    }
    await repo.record(a.id, value.idempotencyKey, hash, ctx.actorId);
    return [(await repo.task(a.id))!, (await repo.task(b.id))!];
  });
}
