import { z } from "zod";
import { OperationRepository } from "../infrastructure/operation-repository";
import {
  operationAllowed,
  operationAudit,
  operationMeta,
  taskResource,
  type OperationDeps,
} from "./operation-service";
import { assignTaskInTransaction } from "./operation-scheduling";
import type { ReservationActorContext } from "./reservation-access";
import {
  ReservationConflictError,
  ReservationNotFoundError,
} from "./reservation-service";
import { dateToUtc } from "../domain/reservation-task";
import { stayDateSchema, localDate } from "../domain/reservation";
import { taskRisk, taskText, propertyInstant } from "../domain/operation-task";
import { saveTaskSeriesSchema } from "../domain/operation-task";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { transitionOperationTask } from "./operation-service";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import {
  operationPolicySchema,
  recurringTasksSchema,
} from "@/platform/config/operation-policy";
import { withTenant } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import { authorize } from "@/platform/authz/authorize";
import { authContextForAccount } from "@/platform/authz/account-context";
import { publishNotification } from "@/platform/notifications/notification-service";
import { logger } from "@/platform/observability/logger";

export const recurringGenerationSchema = z
  .object({ propertyId: z.uuid(), from: stayDateSchema, until: stayDateSchema })
  .strict()
  .refine((v) => v.until >= v.from);
export async function operationSeriesOptions(
  ctx: ReservationActorContext,
  propertyId: string,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "create");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      p = await repo.property(propertyId);
    if (!p) throw new ReservationNotFoundError();
    operationAllowed(ctx, "create", {
      type: "task",
      organizationId: ctx.organizationId,
      propertyId: p.id,
      city: p.cityId ?? p.city,
      region: p.regionId ?? p.region,
    });
    const rule = await repo.recurring(p.id, deps.now);
    return {
      version: rule?.version ?? 0,
      series: rule ? recurringTasksSchema.parse(rule.parsedValue).series : [],
    };
  });
}
export async function saveOperationSeries(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "create");
  const value = saveTaskSeriesSchema.parse(input),
    meta = await operationMeta(deps);
  taskTypeSchema.parse(value.definition.type);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    const p = await repo.property(value.propertyId);
    if (!p) throw new ReservationNotFoundError();
    const resource = {
      type: "task",
      organizationId: ctx.organizationId,
      propertyId: p.id,
      city: p.cityId ?? p.city,
      region: p.regionId ?? p.region,
    };
    operationAllowed(ctx, "create", resource);
    const rule = await repo.recurring(p.id, deps.now);
    if ((rule?.version ?? 0) !== value.expectedVersion)
      throw new ReservationConflictError();
    const before = rule
        ? recurringTasksSchema.parse(rule.parsedValue).series
        : [],
      existing = before.find((s) => s.key === value.definition.key);
    if (existing) operationAllowed(ctx, "edit", resource);
    if (
      !(await repo.checklists(p.id))?.catalog.checklists.some(
        (c) => c.key === value.definition.checklist_template_key,
      )
    )
      throw new ReservationConflictError();
    const series = before
      .filter((s) => s.key !== value.definition.key)
      .concat(value.definition);
    const saved = await new ConfigRuleRepository(
      tx,
      ctx.organizationId,
    ).createVersion({
      key: "ops.recurring_tasks",
      scopeType: "property",
      scopeId: p.id,
      value: { series },
      createdBy: ctx.actorId,
      effectiveFrom: deps.now ?? new Date(),
      reason: value.reason,
    });
    if (!value.definition.enabled && value.cancelFuture) {
      const today = dateToUtc(localDate(deps.now ?? new Date(), p.timezone)),
        tasks = await repo.page(
          {
            propertyId: p.id,
            seriesKey: value.definition.key,
            dueDate: { gte: today },
            state: { in: ["PLANNED", "ASSIGNED", "BLOCKED"] },
          },
          0,
          10000,
        );
      for (const task of tasks)
        await transitionOperationTask(
          ctx,
          {
            taskId: task.id,
            expectedVersion: task.version,
            state: "CANCELLED",
            reason: value.reason,
            idempotencyKey: crypto.randomUUID(),
          },
          { ...deps, ...meta, db: { $transaction: (work) => work(tx) } },
        );
    }
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "task.recurrence.configured",
      resourceType: "config_rule",
      resourceId: saved.id,
      propertyScopeId: p.id,
      before,
      after: series,
      reason: value.reason,
      ...meta,
      occurredAt: new Date(),
    });
    return saved;
  });
}
export async function generateRecurringOperations(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "create");
  const value = recurringGenerationSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    const property = await repo.property(value.propertyId);
    if (!property) throw new ReservationNotFoundError();
    operationAllowed(ctx, "create", {
      type: "task",
      organizationId: ctx.organizationId,
      propertyId: property.id,
      city: property.cityId ?? property.city,
      region: property.regionId ?? property.region,
    });
    const policy = await repo.policy(property.id),
      today = localDate(deps.now ?? new Date(), property.timezone);
    const first = dateToUtc(value.from),
      last = dateToUtc(value.until),
      todayMs = dateToUtc(today).getTime();
    if (
      first.getTime() < todayMs - policy.recurrence_lookback_days * 86400000 ||
      last.getTime() > todayMs + policy.recurrence_horizon_days * 86400000
    )
      throw new ReservationConflictError("recurrence_range_outside_policy");
    const rule = await repo.recurring(property.id, deps.now);
    if (!rule) return { created: 0, existing: 0, more: false };
    const series = recurringTasksSchema.parse(rule.parsedValue).series,
      existingKeys = new Set(
        (await repo.existingOccurrences(property.id, first, last)).map(
          (t) => t.idempotencyKey,
        ),
      );
    let created = 0,
      existing = 0;
    for (const definition of series.filter((s) => s.enabled))
      for (
        let stamp = first.getTime();
        stamp <= last.getTime();
        stamp += 86400000
      ) {
        const date = new Date(stamp).toISOString().slice(0, 10),
          elapsed = Math.round(
            (stamp - dateToUtc(definition.starts_on).getTime()) / 86400000,
          );
        if (
          elapsed < 0 ||
          elapsed % definition.every_days ||
          !definition.weekdays.includes(new Date(stamp).getUTCDay()) ||
          (definition.ends_on && date > definition.ends_on)
        )
          continue;
        const key = `recurring:${property.id}:${definition.key}:${date}`;
        if (existingKeys.has(key)) {
          existing++;
          continue;
        }
        if (created >= 10) return { created, existing, more: true };
        await repo.context(
          ctx.actorId,
          meta.requestId,
          "Generate configured recurring task",
        );
        const row = await repo.create(
          {
            propertyId: property.id,
            type: taskTypeSchema.parse(definition.type),
            title: taskText(definition.title) as { en: string; fr: string },
            dueDate: date,
            priority: definition.priority,
            checklistTemplateKey: definition.checklist_template_key,
            idempotencyKey: key,
            reason: "Generate configured recurring task",
          },
          ctx.actorId,
        );
        const settings = policy.types[definition.type];
        if (!settings)
          throw new ReservationConflictError("operation_type_policy_missing");
        const start = propertyInstant(
          date,
          definition.start_minute,
          property.timezone,
        );
        await repo.update(row.id, {
          seriesKey: definition.key,
          seriesConfigRuleId: rule.id,
          scheduledStart: start,
          scheduledEnd: new Date(
            start.getTime() + settings.duration_minutes * 60000,
          ),
          requiredRoleKey: settings.role_keys[0],
        });
        let task = (await repo.task(row.id))!;
        if (authorize(ctx.authContext, "assign", taskResource(task)))
          task = await assignTaskInTransaction(
            repo,
            ctx,
            task,
            null,
            definition.start_minute,
            meta,
            "Assign configured recurring task",
          );
        await operationAudit(
          repo,
          ctx,
          meta,
          "task.create",
          task,
          null,
          "Generate configured recurring task",
        );
        await repo.event(
          "TaskCreated",
          task.id,
          property.id,
          `task:${task.id}:created`,
        );
        created++;
      }
    return { created, existing, more: false };
  });
}
export async function operationReadiness(
  ctx: ReservationActorContext,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      properties = (await repo.properties()).filter((p) =>
        authorize(ctx.authContext, "view", {
          type: "task",
          organizationId: ctx.organizationId,
          propertyId: p.id,
          city: p.cityId ?? p.city,
          region: p.regionId ?? p.region,
        }),
      );
    const now = deps.now ?? new Date(),
      days = properties.map((p) =>
        dateToUtc(localDate(now, p.timezone)).getTime(),
      ),
      [rows, policies] = await Promise.all([
        repo.readinessTasks(
          properties.map((p) => p.id),
          new Date(days.length ? Math.min(...days) : now.getTime()),
          new Date(days.length ? Math.max(...days) : now.getTime()),
        ),
        repo.policies(
          properties.map((p) => p.id),
          now,
        ),
      ]);
    const failed = new Set(
      (await repo.generationFailures()).flatMap((row) => {
        const p = (row.payload as { propertyId?: unknown })?.propertyId;
        return typeof p === "string" ? [p] : [];
      }),
    );
    const result = [];
    for (const property of properties) {
      const configured = policies.get(property.id);
      if (!configured) {
        result.push({
          propertyId: property.id,
          name: property.name,
          generationFailed: failed.has(property.id),
          readiness: "UNCONFIGURED",
          overdue: 0,
          atRisk: 0,
          unassigned: 0,
        });
        continue;
      }
      const policy = operationPolicySchema.parse(configured.parsedValue),
        today = localDate(now, property.timezone);
      const tasks = rows.filter(
        (t) =>
          t.propertyId === property.id &&
          authorize(ctx.authContext, "view", taskResource(t)),
      );
      const relevant = tasks.filter(
        (t) =>
          policy.readiness_types.includes(t.type) &&
          (t.dueDate.getTime() === dateToUtc(today).getTime() ||
            (!["COMPLETED", "CANCELLED", "SKIPPED"].includes(t.state) &&
              t.dueDate < dateToUtc(today))) &&
          !["CANCELLED", "SKIPPED"].includes(t.state),
      );
      const overdue = tasks.filter(
        (t) => taskRisk(t, now, policy.risk_window_minutes) === "OVERDUE",
      );
      const atRisk = tasks.filter(
        (t) => taskRisk(t, now, policy.risk_window_minutes) === "AT_RISK",
      );
      result.push({
        propertyId: property.id,
        name: property.name,
        generationFailed: failed.has(property.id),
        readiness: relevant.some(
          (t) => taskRisk(t, now, policy.risk_window_minutes) === "OVERDUE",
        )
          ? "NOT_READY"
          : relevant.some((t) => t.state !== "COMPLETED")
            ? "AT_RISK"
            : relevant.length
              ? "READY"
              : "UNCONFIRMED",
        overdue: overdue.length,
        atRisk: atRisk.length,
        unassigned: tasks.filter(
          (t) =>
            !t.assignedToPersonId &&
            !["COMPLETED", "CANCELLED", "SKIPPED"].includes(t.state),
        ).length,
      });
    }
    return result;
  });
}
export async function operationSchedulerProperties(
  organizationId: string,
  deps: OperationDeps = {},
) {
  return withTenant(deps.db ?? prisma, organizationId, async (tx) =>
    (await new OperationRepository(tx, organizationId).properties()).map(
      (p) => p.id,
    ),
  );
}
export async function scheduleOperationTasks(
  organizationId: string,
  deps: OperationDeps & { propertyId?: string } = {},
) {
  const db = deps.db ?? prisma,
    now = deps.now ?? new Date();
  if (deps.propertyId) z.uuid().parse(deps.propertyId);
  const properties = await withTenant(db, organizationId, async (tx) => {
    const repo = new OperationRepository(tx, organizationId);
    if (!deps.propertyId) return repo.properties();
    const p = await repo.property(deps.propertyId);
    return p ? [p] : [];
  });
  let generated = 0;
  for (const p of properties) {
    const configured = await withTenant(db, organizationId, (tx) =>
      new OperationRepository(tx, organizationId).recurring(p.id, now),
    );
    if (
      configured &&
      recurringTasksSchema
        .parse(configured.parsedValue)
        .series.some((s) => s.enabled)
    ) {
      try {
        if (!configured.createdBy) throw new ReservationConflictError();
        const account = await withTenant(db, organizationId, (tx) =>
          new OperationRepository(tx, organizationId).accountPerson(
            configured.createdBy!,
          ),
        );
        if (!account) throw new ReservationNotFoundError();
        const ctx = {
          organizationId,
          actorId: configured.createdBy,
          personId: account.personId,
          authContext: await authContextForAccount(
            organizationId,
            configured.createdBy,
            { db },
          ),
        };
        const policy = await withTenant(db, organizationId, (tx) =>
            new OperationRepository(tx, organizationId).policy(p.id),
          ),
          day = dateToUtc(localDate(now, p.timezone));
        const result = await generateRecurringOperations(
          ctx,
          {
            propertyId: p.id,
            from: new Date(
              day.getTime() - policy.recurrence_lookback_days * 86400000,
            )
              .toISOString()
              .slice(0, 10),
            until: new Date(
              day.getTime() + policy.recurrence_horizon_days * 86400000,
            )
              .toISOString()
              .slice(0, 10),
          },
          { ...deps, requestId: crypto.randomUUID(), now },
        );
        generated += result.created;
        await withTenant(db, organizationId, (tx) =>
          new OperationRepository(tx, organizationId).clearGenerationFailures(
            p.id,
          ),
        );
      } catch {
        await withTenant(db, organizationId, (tx) =>
          new OperationRepository(tx, organizationId).generationFailure(
            p.id,
            `ops-generation:${p.id}:${configured.id}:${localDate(now, p.timezone)}`,
            now,
          ),
        );
        logger.warn(
          "operations recurrence could not generate tasks",
          { organizationId },
          { propertyId: p.id, errorCode: "operations_generation_failed" },
        );
      }
    }
    await withTenant(db, organizationId, async (tx) => {
      const repo = new OperationRepository(tx, organizationId);
      await repo.lock("crew-schedule");
      const policy = await repo.policy(p.id);
      const tasks = await repo.activeTasks([p.id]);
      for (const original of tasks) {
        if (taskRisk(original, now, policy.risk_window_minutes) !== "OVERDUE")
          continue;
        await repo.lock(original.id);
        const task = await repo.task(original.id);
        if (
          !task ||
          taskRisk(task, now, policy.risk_window_minutes) !== "OVERDUE"
        )
          continue;
        const key = `task:${task.id}:overdue:${task.scheduledEnd?.toISOString() ?? task.dueDate.toISOString()}`;
        await repo.event("TaskOverdue", task.id, p.id, key);
        if (task.assignedToUserAccountId)
          await publishNotification(
            tx,
            organizationId,
            {
              kind: "task_overdue",
              recipientId: task.assignedToUserAccountId,
              targetId: task.id,
            },
            `notification:${key}`,
          );
      }
    });
  }
  return { generated };
}
