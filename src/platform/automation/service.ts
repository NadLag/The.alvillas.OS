import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import Decimal from "decimal.js";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import {
  authorize,
  type Action,
  type Resource,
} from "@/platform/authz/authorize";
import { authContextForAccount } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import {
  ConfigRuleRepository,
  resolveConfigCandidates,
} from "@/platform/config/config-rule-repository";
import {
  createConfigRuleVersion,
  activateConfigRuleVersion,
} from "@/modules/config/application/config-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import {
  createOperationTask,
  operationAudit,
} from "@/modules/reservations/application/operation-service";
import { assignTaskInTransaction } from "@/modules/reservations/application/operation-scheduling";
import { ReservationRepository } from "@/modules/reservations/infrastructure/reservation-repository";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { requestApproval } from "@/platform/approvals/approval-service";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { captureReservationCommissionSnapshots } from "@/platform/reservations/finance";
import { Money } from "@/platform/money/money";
import {
  automationRuleSchema,
  dueDate,
  evaluate,
  field,
  scheduleSlot,
  type AutomationAction,
  type AutomationRule,
} from "./rule";
import { AutomationRepository, json } from "./repository";
import { logger } from "@/platform/observability/logger";
import { captureException } from "@/platform/observability/sentry";

export type AutomationActor = ReservationActorContext;
type Deps = { db?: TenantTransactionRunner; now?: Date; requestId?: string };
type Context = Awaited<ReturnType<AutomationRepository["context"]>>;
export class AutomationAccessError extends Error {
  constructor() {
    super("automation_forbidden");
  }
}
function allowed(actor: AutomationActor, action: Action, resource: Resource) {
  if (
    actor.actorId !== actor.authContext.userAccountId ||
    actor.organizationId !== actor.authContext.organizationId ||
    !authorize(actor.authContext, action, resource)
  )
    throw new AutomationAccessError();
}
function resource(
  actor: AutomationActor,
  p?: Context["property"],
  type = "config_rule",
): Resource {
  return {
    type,
    organizationId: actor.organizationId,
    ...(p ? { propertyId: p.id, city: p.cityId, region: p.regionId } : {}),
  };
}
function identity(key: string) {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("automation_input_missing");
  return value;
}
function id(ctx: Context, key: string) {
  return z.string().uuid().parse(field(ctx.evaluation.fields, key));
}
function outcomeKey(rule: AutomationRule, ctx: Context): string {
  if (!rule.idempotency_key) return ctx.event.idempotencyKey;
  const key = rule.idempotency_key.replace(
    /\{\{([a-zA-Z0-9_.]+)\}\}/gu,
    (_, path: string) => text(field(ctx.evaluation.fields, path)),
  );
  if (key.includes("{{") || key.length > 500)
    throw new Error("automation_idempotency_invalid");
  return key;
}
function matches(rule: AutomationRule, ctx: Context): boolean {
  const p = ctx.event.payload as Record<string, unknown>;
  const operation = p.operation;
  const alias =
    ctx.event.type === "reservation.changed"
      ? ((
          {
            CONFIRMED: "ReservationConfirmed",
            CONFIRM: "ReservationConfirmed",
            CANCEL: "ReservationCancelled",
            CHECK_IN: "GuestCheckedIn",
            CHECK_OUT: "GuestCheckedOut",
            IMPORTED: "ReservationImported",
          } as Record<string, string>
        )[String(operation)] ??
        (operation === "TRANSITION"
          ? ((
              {
                CONFIRMED: "ReservationConfirmed",
                CHECKED_IN: "GuestCheckedIn",
                CHECKED_OUT: "GuestCheckedOut",
                CANCELLED: "ReservationCancelled",
              } as Record<string, string>
            )[String(p.state)] ?? "ReservationModified")
          : "ReservationModified"))
      : ctx.event.type;
  return (
    rule.event === ctx.event.type ||
    rule.event === alias ||
    (rule.schedule !== undefined &&
      ctx.event.type === "AutomationScheduled" &&
      p.ruleKey !== undefined)
  );
}
async function audit(
  repo: AutomationRepository,
  actor: AutomationActor,
  action: string,
  resourceId: string,
  propertyId: string | null,
  after: unknown,
  reason: string,
  requestId: string,
) {
  await writeAuditEvent(repo.tx, {
    organizationId: actor.organizationId,
    actorId: actor.actorId,
    action,
    resourceType: "automation",
    resourceId,
    propertyScopeId: propertyId,
    after,
    reason,
    requestId,
    occurredAt: new Date(),
  });
}
async function principal(
  repo: AutomationRepository,
  actorId: string,
): Promise<AutomationActor> {
  const authContext = await authContextForAccount(
    repo.organizationId,
    actorId,
    { db: repo.runner() },
  );
  // Account identity is loaded in the repository; the engine never stores grants.
  const account = await repo.account(actorId);
  if (!account) throw new AutomationAccessError();
  return {
    organizationId: repo.organizationId,
    actorId,
    personId: account.personId,
    authContext: { ...authContext, personId: account.personId },
  };
}
async function actionPlan(
  repo: AutomationRepository,
  actor: AutomationActor,
  action: AutomationAction,
  ctx: Context,
) {
  const p = ctx.property;
  allowed(actor, "configure", resource(actor, p));
  authorizeEvaluation(actor, ctx);
  if (action.type === "create_task" || action.type === "generate_workflow") {
    allowed(actor, "create", resource(actor, p, "task"));
    if (action.type === "generate_workflow") {
      const reservationId = id(ctx, "reservation.id");
      if (!(await repo.activeReservation(reservationId, p.id)))
        throw new Error("automation_reservation_inactive");
      allowed(actor, "view", resource(actor, p, "reservation"));
      return { type: action.type };
    }
    const date = dueDate(action, ctx.evaluation),
      operation = new OperationRepository(repo.tx, repo.organizationId);
    const reservationId = field(ctx.evaluation.fields, "reservation.id");
    if (
      typeof reservationId === "string" &&
      !(await repo.activeReservation(reservationId, p.id))
    )
      throw new Error("automation_reservation_inactive");
    const { taskTypeSchema } = await import("@/platform/config/rule-registry");
    taskTypeSchema.parse(action.task_type);
    if (
      !(await operation.checklists(p.id))?.catalog.checklists.some(
        (c) => c.key === action.checklist_template,
      )
    )
      throw new Error("automation_checklist_missing");
    if (action.assign) allowed(actor, "assign", resource(actor, p, "task"));
    return { type: action.type, dueDate: date, taskType: action.task_type };
  }
  if (action.type === "create_approval_request") {
    if(ctx.payout){
      allowed(actor,"view",ctx.payout.resource);allowed(actor,"edit",ctx.payout.resource);
      if(!ctx.payout.approvalId)throw new Error("automation_payout_approval_not_required");
      return{type:action.type};
    }
    if (ctx.expense) {
      allowed(actor, "view", ctx.expense.resource); allowed(actor, "edit", ctx.expense.resource);
      if (!ctx.expense.approvalId) throw new Error("automation_expense_approval_not_required");
      return { type: action.type };
    }
    allowed(actor, "edit", resource(actor, p, "property"));
    // Any rule depending on finance, including its approval thresholds, needs
    // the same financial visibility as a manual financial request.
    const notifications = new NotificationRepository(
      repo.tx,
      repo.organizationId,
    );
    const routing = await notifications.routing("approval_requested", p.id);
    if (
      !(
        await notifications.approvers(routing, {
          ...resource(actor, p, "property"),
          status: "PENDING",
        })
      ).length
    )
      throw new Error("automation_approvers_missing");
  } else if (action.type === "snapshot" || action.type === "create_variance") {
    allowed(actor, "view", {
      ...resource(actor, p, "financial_transaction"),
      dataClass: "financial",
    });
    allowed(actor, "create", {
      ...resource(actor, p, "financial_transaction"),
      dataClass: "financial",
    });
    if (action.type === "snapshot") {
      id(ctx, "reservation.id");
      allowed(actor, "view", resource(actor, p, "reservation"));
    } else {
      Money.of(
        text(field(ctx.evaluation.fields, action.expected)),
        text(field(ctx.evaluation.fields, action.currency)),
      );
      Money.of(
        text(field(ctx.evaluation.fields, action.actual)),
        text(field(ctx.evaluation.fields, action.currency)),
      );
    }
  } else if (action.type === "reorder_suggestion") {
    allowed(actor, "create", resource(actor, p, "issue"));
    const item = text(field(ctx.evaluation.fields, "inventory.item"));
    const { inventoryMinimumsSchema } = await import(
      "@/platform/config/rule-registry"
    );
    const minimum = inventoryMinimumsSchema
      .parse(ctx.evaluation.configs["inventory.minimums"])
      .minimums.find((v) => v.item === item);
    if (!minimum) throw new Error("automation_inventory_config_missing");
    const quantity = new Decimal(minimum.quantity).minus(
      text(field(ctx.evaluation.fields, "inventory.quantity")),
    );
    if (quantity.lte(0))
      throw new Error("automation_inventory_not_below_minimum");
    return {
      type: action.type,
      item,
      quantity: quantity.toFixed(2),
    };
  } else if (action.type === "notify") {
    const targetId = id(ctx, action.target),
      recipientId = id(ctx, action.recipient);
    const type = action.kind.startsWith("task_")
      ? "task"
      : action.kind.startsWith("approval_")
        ? "property"
        : "reservation";
    allowed(actor, "view", { ...resource(actor, p, type), id: targetId });
    // Notification delivery also rechecks the recipient's current access.
    if (
      !(await new NotificationRepository(
        repo.tx,
        repo.organizationId,
      ).activeRecipient(recipientId))
    )
      throw new Error("automation_recipient_missing");
  }
  return { type: action.type };
}
async function perform(
  repo: AutomationRepository,
  actor: AutomationActor,
  action: AutomationAction,
  ctx: Context,
  key: string,
  requestId: string,
) {
  const plan = await actionPlan(repo, actor, action, ctx),
    db = repo.runner();
  let producedIds: string[] = [];
  if (action.type === "create_task") {
    let task = await createOperationTask(
      actor,
      {
        propertyId: ctx.property.id,
        reservationId: field(ctx.evaluation.fields, "reservation.id"),
        type: action.task_type,
        title: action.title,
        dueDate: plan.dueDate,
        priority: action.priority,
        checklistTemplateKey: action.checklist_template,
        idempotencyKey: identity(key),
        reason: "Automation: " + key,
      },
      { db, requestId },
    );
    if (action.assign) {
      const operation = new OperationRepository(repo.tx, repo.organizationId),
        policy = await operation.policy(ctx.property.id);
      if (!policy) throw new Error("automation_operation_policy_missing");
      await operation.context(actor.actorId, requestId, "Automation: " + key);
      task = await assignTaskInTransaction(
        operation,
        actor,
        task,
        null,
        policy.shift_start_minute,
        { requestId, ipAddress: null },
        "Automation: " + key,
        true,
      );
    }
    producedIds = [task.id];
  } else if (action.type === "generate_workflow") {
    const operation = new OperationRepository(repo.tx, repo.organizationId);
    await operation.context(actor.actorId, requestId, "Automation: " + key);
    const tasks = await new ReservationRepository(
      repo.tx,
      repo.organizationId,
    ).generateConfirmationTasks(
      id(ctx, "reservation.id"),
      actor.actorId,
      actor.personId,
    );
    for (const task of tasks) {
      const full = (await operation.task(task.id))!;
      await operationAudit(
        operation,
        actor,
        { requestId, ipAddress: null },
        "task.create",
        full,
        null,
        "Automation: " + key,
      );
    }
    producedIds = tasks.map((t) => t.id);
  } else if (action.type === "create_approval_request") {
    producedIds = ctx.payout ? [text(ctx.payout.approvalId)] : ctx.expense ? [text(ctx.expense.approvalId)] : [
      (
        await requestApproval(
          {
            organizationId: actor.organizationId,
            accountId: actor.actorId,
            authContext: actor.authContext,
          },
          {
            propertyId: ctx.property.id,
            title: action.title.en,
            details: action.details.en,
            idempotencyKey: identity(key),
          },
          { db, requestId },
        )
      ).id,
    ];
  } else if (action.type === "reorder_suggestion") {
    producedIds = [
      (
        await repo.suggestion({
          propertyId: ctx.property.id,
          outcomeKey: key,
          itemKey: plan.item!,
          title: action.title,
          quantity: plan.quantity!,
          createdBy: actor.actorId,
        })
      ).id,
    ];
  } else if (action.type === "notify") {
    await new NotificationRepository(repo.tx, repo.organizationId).publish(
      {
        kind: action.kind,
        targetId: id(ctx, action.target),
        recipientId: id(ctx, action.recipient),
      },
      key,
    );
  } else if (action.type === "snapshot") {
    const rows = await captureReservationCommissionSnapshots(
      repo.tx,
      repo.organizationId,
      id(ctx, "reservation.id"),
      actor.actorId,
    );
    if (!rows.length || rows.some((r) => r.configurationMissing))
      throw new Error("automation_financial_config_missing");
    producedIds = rows.flatMap((r) =>
      "id" in r && typeof r.id === "string" ? [r.id] : [],
    );
  } else if (action.type === "create_variance") {
    const currency = text(field(ctx.evaluation.fields, action.currency)),
      expected = Money.of(
        text(field(ctx.evaluation.fields, action.expected)),
        currency,
      ),
      actual = Money.of(
        text(field(ctx.evaluation.fields, action.actual)),
        currency,
      );
    const row = await repo.variance({
      propertyId: ctx.property.id,
      sourceType: "AUTOMATION",
      sourceId: ctx.event.id,
      expectedAmount: expected.toJSON().amount,
      actualAmount: actual.toJSON().amount,
      varianceAmount: actual.subtract(expected).toJSON().amount,
      currency,
      reason: action.reason.en,
      action: "REVIEW",
      createdBy: actor.actorId,
    });
    producedIds = [row.id];
  }
  await audit(
    repo,
    actor,
    "automation.action.executed",
    ctx.event.id,
    ctx.property.id,
    { action: action.type, key, producedIds, plan },
    "Configured automation action",
    requestId,
  );
  return { key: action.key, ...plan, producedIds };
}

function authorizeEvaluation(actor: AutomationActor, ctx: Context) {
  // Predicate results are observable. Protect financial inputs before deciding
  // whether a rule matches, including a condition which evaluates to false.
  if (
    ctx.payout || ctx.expense || /^(Expense|Payout|Payment|BankLine|PeriodClosed|Variance)/u.test(
      ctx.event.type,
    ) ||
    Object.hasOwn(ctx.evaluation.fields, "variance") ||
    Object.keys(ctx.evaluation.configs).some((key) =>
      key.startsWith("finance."),
    )
  ) {
    allowed(actor, "view", {
      ...resource(actor, ctx.property, "financial_transaction"),
      ...(ctx.expense ? { ...ctx.expense.resource, type: "financial_transaction" } : {}),
      ...(ctx.payout?ctx.payout.resource:{}),
      dataClass: "financial",
    });
    if (ctx.expense) allowed(actor, "view", ctx.expense.resource);
  }
}
async function restoreEvaluation(repo:AutomationRepository,ctx:Context,value:unknown,inputs:unknown):Promise<unknown>{
  const frozen=inputs as {fields?:Record<string,unknown>;configs?:Record<string,unknown>;configVersions?:unknown};
  if(frozen.fields&&frozen.configs){ctx.evaluation={fields:frozen.fields,configs:frozen.configs};return frozen.configVersions;}
  return(await repo.resolve(value,ctx)).metadata;
}

export const saveAutomationSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u),
    propertyId: z.string().uuid().optional(),
    lifecycle: z.enum(["DRAFT", "ACTIVE"]),
    effectiveFrom: z.coerce.date(),
    effectiveTo: z.coerce.date().optional(),
    rule: automationRuleSchema,
    reason: z.string().trim().min(6).max(500),
  })
  .strict();
export async function saveAutomationRule(
  actor: AutomationActor,
  raw: unknown,
  deps: Deps = {},
) {
  const input = saveAutomationSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, actor.organizationId),
      property = input.propertyId
        ? await repo.property(input.propertyId)
        : undefined;
    if (input.propertyId && !property) throw new AutomationAccessError();
    allowed(actor, "configure", resource(actor, property ?? undefined));
    return createConfigRuleVersion(
      actor,
      {
        key: `automation.rule.${input.key}`,
        scopeType: input.propertyId ? "property" : "organization",
        scopeId: input.propertyId,
        lifecycle: input.lifecycle,
        valueJson: JSON.stringify(input.rule),
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        reason: input.reason,
      },
      { db: repo.runner(), requestId: deps.requestId ?? randomUUID() },
    );
  });
}
export async function changeAutomationState(
  actor: AutomationActor,
  raw: unknown,
  deps: Deps = {},
) {
  const input = z
    .object({
      ruleId: z.uuid(),
      enabled: z.boolean(),
      reason: z.string().trim().min(6).max(500),
    })
    .strict()
    .parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, actor.organizationId),
      source = await repo.rule(input.ruleId);
    if (!source?.key.startsWith("automation.rule."))
      throw new AutomationAccessError();
    if (!["organization", "property"].includes(source.scopeType))
      throw new AutomationAccessError();
    const property =
      source.scopeType === "property" && source.scopeId
        ? await repo.property(source.scopeId)
        : undefined;
    if (source.scopeType === "property" && !property)
      throw new AutomationAccessError();
    allowed(actor, "configure", resource(actor, property ?? undefined));
    const config = new ConfigRuleRepository(tx, actor.organizationId);
    await config.lockVersion(source.key, source.scopeType, source.scopeId);
    if (
      (
        await repo.latestVersion(
          source.key,
          source.scopeType,
          source.scopeId,
          source.lifecycle === "DRAFT",
        )
      )?.id !== source.id
    )
      throw new Error("automation_version_conflict");
    const rule = automationRuleSchema.parse(source.value);
    if (input.enabled)
      await repo.resume(
        source.key,
        source.scopeType === "property" ? source.scopeId : null,
      );
    // Draft activation uses the existing immutable lifecycle workflow.
    if (source.lifecycle === "DRAFT" && input.enabled && rule.enabled)
      return activateConfigRuleVersion(
        actor,
        {
          ruleId: source.id,
          effectiveFrom: deps.now ?? new Date(),
          reason: input.reason,
        },
        { db: repo.runner(), requestId: deps.requestId ?? randomUUID() },
      );
    return saveAutomationRule(
      actor,
      {
        key: source.key.slice(16),
        propertyId:
          source.scopeType === "property" ? source.scopeId : undefined,
        lifecycle: "ACTIVE",
        effectiveFrom: deps.now ?? new Date(),
        rule: { ...rule, enabled: input.enabled },
        reason: input.reason,
      },
      { ...deps, db: repo.runner() },
    );
  });
}
export async function previewAutomation(
  actor: AutomationActor,
  raw: unknown,
  deps: Deps = {},
) {
  const input = z
    .object({ ruleId: z.uuid(), eventId: z.uuid() })
    .strict()
    .parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, actor.organizationId),
      source = await repo.rule(input.ruleId),
      ctx = await repo.context(input.eventId);
    if (
      !source?.key.startsWith("automation.rule.") ||
      !ctx.scopes.some(
        (s) => s.scopeType === source.scopeType && s.scopeId === source.scopeId,
      )
    )
      throw new AutomationAccessError();
    allowed(actor, "view", resource(actor, ctx.property));
    allowed(actor, "configure", resource(actor, ctx.property));
    const { rule, metadata } = await repo.resolve(source.value, ctx);
    authorizeEvaluation(actor, ctx);
    const matched =
        matches(rule, ctx) && evaluate(rule.conditions, ctx.evaluation),
      plans = [];
    for (const action of rule.actions)
      plans.push(await actionPlan(repo, actor, action, ctx));
    // Dry-run audit is the only write: it never reserves outcomes or enqueues work.
    await audit(
      repo,
      actor,
      "automation.previewed",
      source.id,
      ctx.property.id,
      { matched, eventId: input.eventId },
      "Administrator dry run",
      deps.requestId ?? randomUUID(),
    );
    return { matched, plans, configVersions: metadata };
  });
}
export async function enqueueAutomationEvent(
  organizationId: string,
  eventId: string,
  deps: Deps = {},
) {
  z.uuid().parse(eventId);
  return withTenant(deps.db ?? prisma, organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, organizationId),
      ctx = await repo.context(eventId),
      config = new ConfigRuleRepository(tx, organizationId),
      ids: string[] = [];
    for (const { key } of await repo.keys()) {
      const source = await config.resolve({
        key,
        scopes: ctx.scopes,
        asOf: ctx.event.occurredAt,
      });
      if (!source?.createdBy) continue;
      const rule = automationRuleSchema.parse(source.value);
      if (
        ctx.event.type === "AutomationScheduled" &&
        (ctx.event.payload as Record<string, unknown>).ruleKey !== key
      )
        continue;
      if (!matches(rule, ctx)) continue;
      // Keep one invalid rule from rolling back admission of every other rule.
      // Execution validates the original template and records a failed attempt.
      let eventKey: string;
      try {
        eventKey = outcomeKey(rule, ctx);
      } catch {
        eventKey = `invalid-key:${ctx.event.id}`;
      }
      await repo.lock(`${key}:${eventKey}:${ctx.property.id}`);
      const existing = await repo.byKey(key, eventKey, ctx.property.id);
      let frozen: unknown = {
        eventId,
        configRuleId: source.id,
        version: source.version,
      };
      if (!existing) {
        try {
          ctx.evaluation.configs = {};
          const resolved = await repo.resolve(source.value, ctx);
          frozen = {
            ...ctx.evaluation,
            configVersions: resolved.metadata,
            version: source.version,
          };
        } catch {
          /* Missing configuration is recorded by execution and retried under its policy. */
        }
      }
      ids.push(
        existing?.id ??
          (
            await repo.createRun({
              configRuleId: source.id,
              ruleKey: key,
              eventId,
              eventKey,
              propertyId: ctx.property.id,
              actorId: source.createdBy,
              inputs: json(frozen),
              status: rule.enabled ? "PENDING" : "PAUSED",
            })
          ).id,
      );
    }
    return ids;
  });
}
export async function executeAutomationRun(
  organizationId: string,
  runId: string,
  deps: Deps = {},
) {
  const now = deps.now ?? new Date(),
    requestId = deps.requestId ?? randomUUID();
  return withTenant(deps.db ?? prisma, organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, organizationId);
    await repo.lock(runId);
    const run = await repo.run(runId);
    if (!run) throw new AutomationAccessError();
    if (
      ["SUCCEEDED", "SKIPPED", "FAILED"].includes(run.status) ||
      (run.nextAttemptAt && run.nextAttemptAt > now)
    )
      return run.status;
    const source = await repo.rule(run.configRuleId);
    if (!source) throw new Error("automation_rule_missing");
    const config = new ConfigRuleRepository(tx, organizationId);
    const rule = automationRuleSchema.parse(source.value);
    await repo.savepoint();
    let evaluatedInput: unknown;
    try {
      const actor = await principal(repo, run.actorId),
        ctx = await repo.context(run.eventId, run.propertyId);
      allowed(actor, "configure", resource(actor, ctx.property));
      // Lock candidate scopes in a stable order, including inherited rules:
      // a newly paused property override must stop a queued organization rule.
      for (const scope of [...ctx.scopes].sort((a, b) =>
        `${a.scopeType}:${a.scopeId ?? ""}`.localeCompare(
          `${b.scopeType}:${b.scopeId ?? ""}`,
        ),
      ))
        await config.lockVersion(source.key, scope.scopeType, scope.scopeId);
      const latest = await config.resolve({
        key: source.key,
        scopes: ctx.scopes,
        asOf: now,
      });
      if (!latest || !automationRuleSchema.parse(latest.value).enabled) {
        await repo.update(run.id, { status: "PAUSED", nextAttemptAt: null });
        await repo.release();
        return "PAUSED";
      }
      const metadata=await restoreEvaluation(repo,ctx,source.value,run.inputs);
      evaluatedInput = {
        ...ctx.evaluation,
        configVersions: metadata,
        ruleVersion: source.version,
      };
      authorizeEvaluation(actor, ctx);
      const matched = evaluate(rule.conditions, ctx.evaluation),
        outputs = [];
      if (matched) {
        outcomeKey(rule, ctx);
        await repo.causation(ctx.event.payload, source.key);
        for (const action of rule.actions)
          outputs.push(
            await perform(
              repo,
              actor,
              action,
              ctx,
              `${run.id}:${action.key}`,
              requestId,
            ),
          );
      }
      const status = matched ? "SUCCEEDED" : "SKIPPED";
      await repo.update(run.id, {
        status,
        attemptCount: { increment: 1 },
        inputs: json({
          ...ctx.evaluation,
          configVersions: metadata,
          ruleVersion: source.version,
        }),
        outputs: json(outputs),
        errorCode: null,
        nextAttemptAt: null,
        completedAt: now,
      });
      await repo.attempt({
        runId: run.id,
        number: run.attemptCount + 1,
        status,
        outputs: json(outputs),
        requestId,
      });
      await audit(
        repo,
        actor,
        "automation.run.completed",
        run.id,
        run.propertyId,
        { status, configRuleId: source.id, ruleVersion: source.version },
        "Automation evaluation completed",
        requestId,
      );
      await repo.release();
      return status;
    } catch (error) {
      await repo.rollback();
      await repo.release();
      const number = run.attemptCount + 1,
        permanent =
          error instanceof AutomationAccessError || error instanceof z.ZodError;
      const status =
        permanent || number >= rule.retry.max_attempts ? "FAILED" : "RETRY";
      const errorCode =
        error instanceof AutomationAccessError
          ? "automation_forbidden"
          : error instanceof Error &&
              /^automation_[a-z_]+$/u.test(error.message)
            ? error.message
            : "automation_action_failed";
      await repo.update(run.id, {
        status,
        errorCode,
        ...(evaluatedInput ? { inputs: json(evaluatedInput) } : {}),
        attemptCount: number,
        nextAttemptAt:
          status === "RETRY"
            ? new Date(now.getTime() + rule.retry.delay_seconds * 1000 * number)
            : null,
        completedAt: status === "FAILED" ? now : null,
      });
      await repo.attempt({
        runId: run.id,
        number,
        status,
        errorCode,
        outputs: [],
        requestId,
      });
      await writeAuditEvent(tx, {
        organizationId,
        actorId: run.actorId,
        action: "automation.run.failed",
        resourceType: "automation",
        resourceId: run.id,
        propertyScopeId: run.propertyId,
        after: { status, errorCode, attempt: number },
        reason: "Automation failed safely",
        requestId,
        occurredAt: now,
      });
      logger.error(
        "automation execution failed",
        { organizationId, requestId, jobId: run.id },
        { errorCode, status },
      );
      await captureException(new Error(errorCode), {
        source: "job",
        organizationId,
        requestId,
        jobId: run.id,
        tags: { kind: "automation", status },
      });
      return status;
    }
  });
}
export async function replayAutomation(
  actor: AutomationActor,
  raw: unknown,
  deps: Deps = {},
) {
  const input = z
    .object({ runId: z.uuid(), reason: z.string().trim().min(6).max(500) })
    .strict()
    .parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, actor.organizationId);
    await repo.lock(input.runId);
    const run = await repo.run(input.runId);
    if (!run) throw new AutomationAccessError();
    const property = await repo.property(run.propertyId);
    if (!property) throw new AutomationAccessError();
    const current=await principal(repo,actor.actorId);
    for(const authority of [actor,current])allowed(authority,"configure",resource(authority,property));
    const ctx=await repo.context(run.eventId,run.propertyId),source=await repo.rule(run.configRuleId);
    if(!source)throw new AutomationAccessError();
    const rule=automationRuleSchema.parse(source.value);
    await restoreEvaluation(repo,ctx,source.value,run.inputs);
    for(const authority of [actor,current])authorizeEvaluation(authority,ctx);
    if (["SUCCEEDED", "SKIPPED"].includes(run.status)) return run.status;
    for(const authority of [actor,current])for(const action of rule.actions)await actionPlan(repo,authority,action,ctx);
    await repo.update(run.id, {
      status: "PENDING",
      nextAttemptAt: null,
      completedAt: null,
    });
    await audit(
      repo,
      actor,
      "automation.run.replayed",
      run.id,
      run.propertyId,
      { configRuleId: run.configRuleId },
      input.reason,
      deps.requestId ?? randomUUID(),
    );
    return "PENDING";
  });
}
export async function automationTick(organizationId: string, deps: Deps = {}) {
  const now = deps.now ?? new Date();
  const events = await withTenant(
    deps.db ?? prisma,
    organizationId,
    async (tx) => {
      const repo = new AutomationRepository(tx, organizationId),
        occurrences: Array<{
          ruleKey: string;
          propertyId: string;
          date: string;
        }> = [];
      const candidates = await repo.scheduleCandidates(now);
      const keys = [
        ...new Set(
          candidates
            .filter(
              (c) =>
                c.lifecycle === "ACTIVE" &&
                automationRuleSchema.parse(c.value).schedule,
            )
            .map((c) => c.key),
        ),
      ];
      if (!keys.length) return [];
      const properties = await repo.properties(),
        allScopes = await repo.propertyScopes(
          properties.map((p) => p.id),
          now,
        );
      for (const p of properties)
        for (const key of keys) {
          const scopes = allScopes.get(p.id) ?? [];
          const source = resolveConfigCandidates(
            candidates.filter(
              (c) =>
                c.key === key &&
                scopes.some(
                  (s) => s.scopeType === c.scopeType && s.scopeId === c.scopeId,
                ),
            ),
          );
          if (!source) continue;
          const rule = automationRuleSchema.parse(source.value);
          if (!rule.enabled) continue;
          const slot = scheduleSlot(rule, p.timezone, now);
          if (slot)
            occurrences.push({ ruleKey: key, propertyId: p.id, date: slot });
        }
      return (await repo.scheduleEvents(occurrences, now)).map((e) => e.id);
    },
  );
  for (const eventId of events)
    await enqueueAutomationEvent(organizationId, eventId, deps);
  const due = await withTenant(deps.db ?? prisma, organizationId, (tx) =>
    new AutomationRepository(tx, organizationId).due(now),
  );
  for (const { id } of due)
    await executeAutomationRun(organizationId, id, deps);
  return { scheduled: events.length, processed: due.length };
}
export async function automationAdmin(
  actor: AutomationActor,
  before?: { createdAt: Date; id: string },
  deps: Deps = {},
  selection: {
    propertyId?: string;
    versionsBefore?: { createdAt: Date; id: string };
  } = {},
) {
  if (
    actor.authContext.organizationId !== actor.organizationId ||
    actor.authContext.userAccountId !== actor.actorId
  )
    throw new AutomationAccessError();
  return withTenant(deps.db ?? prisma, actor.organizationId, async (tx) => {
    const repo = new AutomationRepository(tx, actor.organizationId),
      all = await repo.properties();
    const properties = all.filter(
      (p) =>
        authorize(actor.authContext, "view", resource(actor, p)) &&
        authorize(actor.authContext, "configure", resource(actor, p)),
    );
    if (!properties.length) allowed(actor, "view", resource(actor));
    if (
      selection.propertyId &&
      !properties.some((p) => p.id === selection.propertyId)
    )
      throw new AutomationAccessError();
    const ids = selection.propertyId
        ? [selection.propertyId]
        : properties.map((p) => p.id),
      [runs, versions, sources, suggestions] = await Promise.all([
        repo.history(ids, before),
        repo.versions(ids, selection.versionsBefore),
        repo.sources(ids),
        repo.suggestions(ids),
      ]);
    const safeRuns = runs.map((run) => {
      const property = properties.find((p) => p.id === run.propertyId)!;
      const financial = authorize(actor.authContext, "view", {
        ...resource(actor, property, "financial_transaction"),
        dataClass: "financial",
      });
      return present(
        {
          ...actor.authContext,
          visibleDataClasses: new Set(financial ? ["financial" as const] : []),
        },
        "view",
        {
          ...resource(actor, property),
          data: {
            ...run,
            createdAt: run.createdAt.toISOString(),
            completedAt: run.completedAt?.toISOString() ?? null,
            attempts: run.attempts.map((a) => ({
              number: a.number,
              status: a.status,
              errorCode: a.errorCode,
            })),
            inputs: run.inputs,
            outputs: run.outputs,
          },
        },
        {
          inputs: { dataClass: "financial" },
          outputs: { dataClass: "financial" },
          eventKey: { dataClass: "financial" },
        },
      );
    });
    return {
      effectiveDefault: (deps.now ?? new Date()).toISOString().slice(0, 16),
      properties,
      selectedPropertyId: selection.propertyId ?? "",
      versions: versions.filter(
        (v) =>
          v.scopeType !== "organization" ||
          authorize(actor.authContext, "view", resource(actor)),
      ),
      runs: safeRuns,
      sources: sources.map((s) => ({
        ...s,
        occurredAt: s.occurredAt.toISOString(),
      })),
      suggestions: suggestions
        .filter((s) => {
          const property = properties.find((p) => p.id === s.propertyId);
          return (
            property &&
            authorize(actor.authContext, "view", {
              ...resource(actor, property, "issue"),
              id: s.id,
            })
          );
        })
        .map((s) => ({
          ...s,
          quantity: s.quantity.toFixed(2),
          createdAt: s.createdAt.toISOString(),
        })),
    };
  });
}
