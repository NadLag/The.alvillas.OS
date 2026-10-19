import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { OperationRepository } from "../infrastructure/operation-repository";
import {
  bulkTaskSchema,
  taskQuerySchema,
  taskRisk,
  taskStates,
  terminalTaskStates,
} from "../domain/operation-task";
import { dateToUtc } from "../domain/reservation-task";
import { operationPolicySchema } from "@/platform/config/operation-policy";
import { localDate } from "../domain/reservation";
import {
  operationScope,
  operationAllowed,
  operationAudit,
  operationHash,
  operationMeta,
  taskResource,
  type OperationDeps,
} from "./operation-service";
import {
  operationStartMinute,
  assignOperationTask,
  rescheduleOperationTask,
} from "./operation-scheduling";
import {
  transitionOperationTask,
  type OperationTask,
} from "./operation-service";
import {
  ReservationConflictError,
  ReservationNotFoundError,
} from "./reservation-service";
import type { ReservationActorContext } from "./reservation-access";
import { authorize } from "@/platform/authz/authorize";
import { present, maskedValue } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
export function taskDateRange(
  query: z.infer<typeof taskQuerySchema>,
  now: Date,
  timezone = "Africa/Casablanca",
) {
  let from = query.from,
    until = query.until;
  const anchor = dateToUtc(
    query.date ?? query.from ?? localDate(now, timezone),
  );
  if (query.view === "DAY") from = until = anchor.toISOString().slice(0, 10);
  if (query.view === "WEEK") {
    const start = new Date(
      anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * 86400000,
    );
    from = start.toISOString().slice(0, 10);
    until = new Date(start.getTime() + 6 * 86400000).toISOString().slice(0, 10);
  }
  if (query.view === "MONTH") {
    from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    until = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0),
    )
      .toISOString()
      .slice(0, 10);
  }
  if (query.view === "LIST" || query.view === "TIMELINE") {
    if (query.date) from = until = query.date;
  }
  if (query.from && (!from || query.from > from)) from = query.from;
  if (query.until && (!until || query.until < until)) until = query.until;
  return { from, until };
}
export async function operationManagement(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  const query = taskQuerySchema.parse(input),
    now = deps.now ?? new Date();
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      properties = await repo.properties(),
      range = taskDateRange(
        query,
        now,
        properties.find((p) => p.id === query.propertyId)?.timezone,
      );
    const { groups, visible } = await operationScope(
      ctx,
      "view",
      repo,
      properties,
    );
    const where: Prisma.OperationTaskWhereInput = {
      AND: [
        { OR: groups },
        ...(query.propertyId ? [{ propertyId: query.propertyId }] : []),
        ...(query.workerId ? [{ assignedToPersonId: query.workerId }] : []),
        ...(query.role ? [{ requiredRoleKey: query.role }] : []),
        ...(query.priority ? [{ priority: query.priority }] : []),
        ...(query.type ? [{ type: query.type }] : []),
        ...(query.state &&
        taskStates.includes(query.state as (typeof taskStates)[number])
          ? [{ state: query.state }]
          : []),
        ...(range.from || range.until
          ? [
              {
                dueDate: {
                  gte: range.from ? dateToUtc(range.from) : undefined,
                  lte: range.until ? dateToUtc(range.until) : undefined,
                },
              },
            ]
          : []),
      ],
    };
    const policies = await repo.policies([...visible], now);
    // Derived exceptions must filter before pagination; scheduled deadlines are UTC.
    if (query.state === "OVERDUE" || query.state === "AT_RISK") {
      const exceptions: Prisma.OperationTaskWhereInput[] = [];
      for (const p of properties.filter((p) => visible.has(p.id))) {
        const configured = policies.get(p.id);
        if (!configured) continue;
        const policy = operationPolicySchema.parse(configured.parsedValue),
          today = dateToUtc(localDate(now, p.timezone)),
          window = new Date(now.getTime() + policy.risk_window_minutes * 60000),
          windowDay = dateToUtc(localDate(window, p.timezone));
        const overdue: Prisma.OperationTaskWhereInput = {
          OR: [
            { scheduledEnd: { lt: now } },
            { scheduledEnd: null, dueDate: { lt: today } },
          ],
        };
        exceptions.push({
          propertyId: p.id,
          state: { notIn: [...terminalTaskStates] },
          ...(query.state === "OVERDUE"
            ? overdue
            : {
                AND: [
                  { NOT: overdue },
                  {
                    OR: [
                      { state: "BLOCKED" },
                      {
                        assignedToPersonId: null,
                        OR: [
                          { scheduledEnd: { gte: now, lte: window } },
                          {
                            scheduledEnd: null,
                            dueDate: { gte: today, lt: windowDay },
                          },
                        ],
                      },
                    ],
                  },
                ],
              }),
        });
      }
      (where.AND as Prisma.OperationTaskWhereInput[]).push({ OR: exceptions });
    }
    const size = query.view === "LIST" ? 50 : 200;
    const [tasks, count, views, workerGroups, team] = await Promise.all([
      repo.page(where, (query.page - 1) * size, size),
      repo.count(where),
      repo.views(ctx.actorId),
      repo.workerGroups(where),
      repo.team(),
    ]);
    const people = await repo.people(
      workerGroups.map((g) => g.assignedToPersonId!).filter(Boolean),
    );
    const workers = people.map((person) => {
      const resource = (propertyId: string) => {
        const p = properties.find((p) => p.id === propertyId);
        return {
          type: "team_member",
          organizationId: ctx.organizationId,
          id: person.id,
          propertyId,
          city: p?.cityId ?? p?.city,
          region: p?.regionId ?? p?.region,
        };
      };
      const group = workerGroups.find(
        (g) =>
          g.assignedToPersonId === person.id &&
          authorize(ctx.authContext, "view", resource(g.propertyId)),
      );
      const name = group
        ? present(
            { ...ctx.authContext, visibleDataClasses: new Set() },
            "view",
            { ...resource(group.propertyId), data: person },
            {
              displayName: {
                dataClass: "personal",
                requiredPermission: "team_member:view",
              },
            },
          ).displayName
        : maskedValue;
      return { id: person.id, name: name ?? maskedValue };
    });
    const crew = new Map<string, { id: string; name: string }>();
    for (const row of team) {
      if (
        row.validFrom > now ||
        (row.validTo && row.validTo <= now) ||
        row.userAccount?.status !== "ACTIVE"
      )
        continue;
      for (const p of properties.filter((p) => visible.has(p.id))) {
        const resource = {
          type: "team_member",
          organizationId: ctx.organizationId,
          id: row.personId,
          propertyId: p.id,
          city: p.cityId ?? p.city,
          region: p.regionId ?? p.region,
        };
        if (!authorize(ctx.authContext, "view", resource)) continue;
        const data = present(
          { ...ctx.authContext, visibleDataClasses: new Set() },
          "view",
          { ...resource, data: row.person },
          {
            displayName: {
              dataClass: "personal",
              requiredPermission: "team_member:view",
            },
          },
        );
        crew.set(row.personId, {
          id: row.personId,
          name: data.displayName ?? maskedValue,
        });
        break;
      }
    }
    return {
      query,
      range,
      workers,
      crew: [...crew.values()].sort((a, b) => a.name.localeCompare(b.name)),
      tasks: tasks
        .filter((t) => authorize(ctx.authContext, "view", taskResource(t)))
        .map((task) => ({
          ...task,
          risk: policies.get(task.propertyId)
            ? taskRisk(
                task,
                now,
                operationPolicySchema.parse(
                  policies.get(task.propertyId)!.parsedValue,
                ).risk_window_minutes,
              )
            : "CLEAR",
        })),
      count,
      size,
      properties: properties.filter((p) => visible.has(p.id)),
      views,
    };
  });
}
export async function saveOperationView(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  const value = z
    .object({
      name: z.string().trim().min(1).max(80),
      filters: taskQuerySchema,
    })
    .strict()
    .parse(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, (tx) =>
    new OperationRepository(tx, ctx.organizationId).saveView(
      ctx.actorId,
      value.name,
      value.filters,
    ),
  );
}
export async function archiveOperationView(
  ctx: ReservationActorContext,
  id: string,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  z.uuid().parse(id);
  return withTenant(deps.db ?? prisma, ctx.organizationId, (tx) =>
    new OperationRepository(tx, ctx.organizationId).archiveView(
      ctx.actorId,
      id,
    ),
  );
}
export async function bulkOperationTasks(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  const value = bulkTaskSchema.parse(input),
    action = value.action === "ASSIGN" ? "assign" : "edit";
  operationAllowed(ctx, action);
  const meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    for (const item of [...value.items].sort((a, b) =>
      a.taskId.localeCompare(b.taskId),
    ))
      await repo.lock(item.taskId);
    await repo.lock(value.idempotencyKey);
    const rows: OperationTask[] = [];
    for (const item of value.items) {
      const task = await repo.task(item.taskId);
      if (!task) throw new ReservationNotFoundError();
      operationAllowed(ctx, action, taskResource(task));
      rows.push(task);
    }
    const hash = operationHash({ operation: "bulk", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      return { changed: 0, idempotent: true };
    }
    for (let i = 0; i < rows.length; i++)
      if (
        rows[i].version !== value.items[i].expectedVersion ||
        terminalTaskStates.includes(rows[i].state)
      )
        throw new ReservationConflictError();
    for (const task of rows) {
      const nested = {
        ...deps,
        ...meta,
        db: {
          $transaction: <T>(work: (tx: typeof repo.tx) => Promise<T>) =>
            work(tx),
        },
      };
      const key = crypto.randomUUID();
      const minute =
        value.action === "ASSIGN" || value.action === "RESCHEDULE"
          ? (value.startMinute ??
            operationStartMinute(task, await repo.policy(task.propertyId)))
          : undefined;
      if (value.action === "ASSIGN")
        await assignOperationTask(
          ctx,
          {
            taskId: task.id,
            expectedVersion: task.version,
            personId: value.personId,
            startMinute: minute,
            reason: value.reason,
            idempotencyKey: key,
          },
          nested,
        );
      else if (value.action === "RESCHEDULE")
        await rescheduleOperationTask(
          ctx,
          {
            taskId: task.id,
            expectedVersion: task.version,
            dueDate: value.dueDate,
            startMinute: minute,
            reason: value.reason,
            idempotencyKey: key,
          },
          nested,
        );
      else if (value.action === "CANCEL")
        await transitionOperationTask(
          ctx,
          {
            taskId: task.id,
            expectedVersion: task.version,
            state: "CANCELLED",
            reason: value.reason,
            idempotencyKey: key,
          },
          nested,
        );
      else {
        await repo.context(ctx.actorId, meta.requestId, value.reason);
        await repo.update(task.id, { priority: value.priority });
        await operationAudit(
          repo,
          ctx,
          meta,
          "task.priority.changed",
          (await repo.task(task.id))!,
          task,
          value.reason,
        );
      }
    }
    await repo.record(rows[0].id, value.idempotencyKey, hash, ctx.actorId);
    return { changed: rows.length, idempotent: false };
  });
}
