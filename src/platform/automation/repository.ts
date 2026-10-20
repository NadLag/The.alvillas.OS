import { Prisma } from "@prisma/client";
import type {
  TenantTransaction,
  TenantTransactionRunner,
} from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import {
  automationRuleSchema,
  referencedConfigs,
  type EvaluationContext,
} from "./rule";
import { z } from "zod";

export const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const uuid = z.string().uuid();
const inventory = z
  .object({
    item: z.string().regex(/^[a-z0-9_.-]{1,120}$/u),
    quantity: z.string().regex(/^-?\d+(\.\d{1,2})?$/u),
  })
  .strict();
const amounts = z
  .object({
    expected: z.string().regex(/^-?\d+(\.\d{1,2})?$/u),
    actual: z.string().regex(/^-?\d+(\.\d{1,2})?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
  })
  .strict();
export class AutomationRepository {
  constructor(
    readonly tx: TenantTransaction,
    readonly organizationId: string,
  ) {}
  runner(): TenantTransactionRunner {
    return { $transaction: async (work) => work(this.tx) };
  }
  async lock(key: string) {
    await this.tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`automation:${this.organizationId}:${key}`},0))`,
    );
  }
  savepoint() {
    return this.tx.$executeRawUnsafe("SAVEPOINT automation_actions");
  }
  rollback() {
    return this.tx.$executeRawUnsafe(
      "ROLLBACK TO SAVEPOINT automation_actions",
    );
  }
  release() {
    return this.tx.$executeRawUnsafe("RELEASE SAVEPOINT automation_actions");
  }
  async causation(payload: unknown, ruleKey: string) {
    const chain =
      z
        .object({ automationPath: z.array(z.string()).max(16).optional() })
        .passthrough()
        .parse(payload).automationPath ?? [];
    if (chain.includes(ruleKey) || chain.length >= 16)
      throw new Error("automation_cycle_detected");
    await this.tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.automation_path',${JSON.stringify([...chain, ruleKey])},true)`,
    );
  }
  event(id: string) {
    return this.tx.outboxEvent.findFirst({
      where: { organizationId: this.organizationId, id },
    });
  }
  rule(id: string) {
    return new ConfigRuleRepository(this.tx, this.organizationId).findById(id);
  }
  latestVersion(
    key: string,
    scopeType: string,
    scopeId: string | null,
    draft: boolean,
  ) {
    return this.tx.configRule.findFirst({
      where: {
        organizationId: this.organizationId,
        key,
        scopeType,
        scopeId,
        archivedAt: null,
        lifecycle: draft ? "DRAFT" : { not: "DRAFT" },
      },
      orderBy: { version: "desc" },
      select: { id: true },
    });
  }
  account(id: string) {
    return this.tx.userAccount.findFirst({
      where: { organizationId: this.organizationId, id, status: "ACTIVE" },
      select: { personId: true },
    });
  }
  async activeReservation(id: string, propertyId: string) {
    await this.tx.$queryRaw(
      Prisma.sql`SELECT id FROM reservation WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid FOR SHARE`,
    );
    return this.tx.reservation.findFirst({
      where: {
        organizationId: this.organizationId,
        id,
        propertyId,
        archivedAt: null,
        status: { notIn: ["CANCELLED", "NO_SHOW", "CLOSED"] },
      },
      select: { id: true },
    });
  }
  async keys() {
    return this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        key: { startsWith: "automation.rule." },
        archivedAt: null,
      },
      distinct: ["key"],
      select: { key: true },
      orderBy: { key: "asc" },
    });
  }
  scheduleCandidates(now: Date) {
    return this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        key: { startsWith: "automation.rule." },
        archivedAt: null,
        lifecycle: { in: ["ACTIVE", "RETIRED"] },
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { key: "asc" },
    });
  }
  propertyScopes(ids: string[], asOf: Date) {
    return new ReservationConfigScopeRepository(
      this.tx,
      this.organizationId,
    ).propertyScopes(ids, asOf);
  }
  async context(
    eventId: string,
    propertyOverride?: string,
  ): Promise<{
    event: NonNullable<Awaited<ReturnType<AutomationRepository["event"]>>>;
    property: NonNullable<
      Awaited<ReturnType<AutomationRepository["property"]>>
    >;
    evaluation: EvaluationContext;
    scopes: Awaited<ReturnType<ReservationConfigScopeRepository["scopes"]>>;
  }> {
    const event = await this.event(eventId);
    if (!event) throw new Error("automation_source_missing");
    const p = event.payload as Record<string, unknown>;
    const reservation = uuid.safeParse(p.reservationId).success
      ? await this.tx.reservation.findFirst({
          where: {
            organizationId: this.organizationId,
            id: String(p.reservationId),
            archivedAt: null,
          },
        })
      : null;
    const task = uuid.safeParse(p.taskId).success
      ? await this.tx.operationTask.findFirst({
          where: {
            organizationId: this.organizationId,
            id: String(p.taskId),
            archivedAt: null,
          },
        })
      : null;
    const approval = uuid.safeParse(p.approvalId).success
      ? await this.tx.approvalRequest.findFirst({
          where: {
            organizationId: this.organizationId,
            id: String(p.approvalId),
          },
        })
      : null;
    if (
      (p.reservationId && !reservation) ||
      (p.taskId && !task) ||
      (p.approvalId && !approval)
    )
      throw new Error("automation_source_missing");
    const id =
      propertyOverride ??
      reservation?.propertyId ??
      task?.propertyId ??
      approval?.propertyId ??
      String(p.propertyId);
    for (const ref of [
      p.propertyId,
      reservation?.propertyId,
      task?.propertyId,
      approval?.propertyId,
    ])
      if (ref && ref !== id) throw new Error("automation_scope_mismatch");
    const property = await this.property(id);
    if (!property) throw new Error("automation_source_missing");
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const fields: Record<string, unknown> = {
      event: {
        id: event.id,
        type: event.type,
        date:
          typeof p.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(p.date)
            ? p.date
            : new Intl.DateTimeFormat("en-CA", {
                timeZone: property.timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(event.occurredAt),
        occurred_at: event.occurredAt.toISOString(),
      },
      property: { id: property.id, timezone: property.timezone },
      ...(reservation
        ? {
            reservation: {
              id: reservation.id,
              status:
                typeof p.state === "string" ? p.state : reservation.status,
              check_in:
                typeof p.checkIn === "string"
                  ? p.checkIn
                  : day(reservation.checkIn),
              check_out:
                typeof p.checkOut === "string"
                  ? p.checkOut
                  : day(reservation.checkOut),
              created_by: reservation.createdBy,
              nights:
                (new Date(
                  typeof p.checkOut === "string"
                    ? p.checkOut
                    : reservation.checkOut,
                ).getTime() -
                  new Date(
                    typeof p.checkIn === "string"
                      ? p.checkIn
                      : reservation.checkIn,
                  ).getTime()) /
                86400000,
              version: Number(p.version ?? reservation.version),
            },
          }
        : {}),
      ...(task
        ? {
            task: {
              id: task.id,
              type: task.type,
              status: task.state,
              due_date: day(task.dueDate),
              assigned_to: task.assignedToUserAccountId,
            },
          }
        : {}),
      ...(approval
        ? {
            approval: {
              id: approval.id,
              status: approval.state,
              requested_by: approval.requestedBy,
            },
          }
        : {}),
      ...(p.inventory ? { inventory: inventory.parse(p.inventory) } : {}),
      ...(p.variance ? { variance: amounts.parse(p.variance) } : {}),
    };
    const scopes = await new ReservationConfigScopeRepository(
      this.tx,
      this.organizationId,
    ).scopes({
      propertyId: id,
      source: reservation?.source,
      asOf: event.occurredAt,
    });
    return { event, property, evaluation: { fields, configs: {} }, scopes };
  }
  property(id: string) {
    return this.tx.property.findFirst({
      where: {
        organizationId: this.organizationId,
        id: uuid.parse(id),
        archivedAt: null,
      },
      select: {
        id: true,
        name: true,
        timezone: true,
        cityId: true,
        regionId: true,
      },
    });
  }
  properties() {
    return this.tx.property.findMany({
      where: { organizationId: this.organizationId, archivedAt: null },
      select: {
        id: true,
        name: true,
        timezone: true,
        cityId: true,
        regionId: true,
      },
      orderBy: { id: "asc" },
    });
  }
  async resolve(
    rule: unknown,
    ctx: Awaited<ReturnType<AutomationRepository["context"]>>,
  ) {
    const parsed = automationRuleSchema.parse(rule);
    const config = new ConfigRuleRepository(this.tx, this.organizationId),
      metadata = [];
    const keys = new Set(referencedConfigs(parsed));
    if (parsed.actions.some((action) => action.type === "reorder_suggestion"))
      keys.add("inventory.minimums");
    for (const key of keys) {
      const resolved = await config.resolve({
        key,
        scopes: ctx.scopes,
        asOf: ctx.event.occurredAt,
      });
      if (!resolved) throw new Error("automation_config_missing");
      ctx.evaluation.configs[key] = resolved.parsedValue;
      metadata.push({ key, id: resolved.id, version: resolved.version });
    }
    return { rule: parsed, metadata };
  }
  run(id: string) {
    return this.tx.automationRun.findFirst({
      where: { organizationId: this.organizationId, id },
      include: { attempts: { orderBy: { number: "asc" } } },
    });
  }
  createRun(
    data: Omit<Prisma.AutomationRunUncheckedCreateInput, "organizationId">,
  ) {
    return this.tx.automationRun.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }
  byKey(ruleKey: string, eventKey: string, propertyId: string) {
    return this.tx.automationRun.findUnique({
      where: {
        organizationId_ruleKey_eventKey_propertyId: {
          organizationId: this.organizationId,
          ruleKey,
          eventKey,
          propertyId,
        },
      },
    });
  }
  update(id: string, data: Prisma.AutomationRunUpdateInput) {
    return this.tx.automationRun.update({
      where: { organizationId: this.organizationId, id },
      data,
    });
  }
  resume(ruleKey: string, propertyId: string | null) {
    return this.tx.automationRun.updateMany({
      where: {
        organizationId: this.organizationId,
        ruleKey,
        status: "PAUSED",
        ...(propertyId ? { propertyId } : {}),
      },
      data: { status: "PENDING", nextAttemptAt: null },
    });
  }
  attempt(
    data: Omit<Prisma.AutomationAttemptUncheckedCreateInput, "organizationId">,
  ) {
    return this.tx.automationAttempt.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }
  due(now: Date) {
    return this.tx.automationRun.findMany({
      where: {
        organizationId: this.organizationId,
        status: { in: ["PENDING", "RETRY"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
      take: 100,
      select: { id: true },
    });
  }
  history(propertyIds: string[], before?: { createdAt: Date; id: string }) {
    return this.tx.automationRun.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: { in: propertyIds },
        ...(before
          ? {
              OR: [
                { createdAt: { lt: before.createdAt } },
                { createdAt: before.createdAt, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      include: { attempts: { orderBy: { number: "asc" } } },
    });
  }
  versions(propertyIds: string[], before?: { createdAt: Date; id: string }) {
    return this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        key: { startsWith: "automation.rule." },
        OR: [
          { scopeType: "organization", scopeId: null },
          { scopeType: "property", scopeId: { in: propertyIds } },
        ],
        ...(before
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: before.createdAt } },
                    { createdAt: before.createdAt, id: { lt: before.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
  }
  sources(propertyIds: string[]) {
    return this.tx.outboxEvent.findMany({
      where: {
        organizationId: this.organizationId,
        OR: propertyIds.map((id) => ({
          payload: { path: ["propertyId"], equals: id },
        })),
      },
      orderBy: { occurredAt: "desc" },
      take: 50,
      select: { id: true, type: true, occurredAt: true },
    });
  }
  async suggestion(data: {
    propertyId: string;
    outcomeKey: string;
    itemKey: string;
    title: unknown;
    quantity: string;
    createdBy: string;
  }) {
    return this.tx.automationSuggestion.upsert({
      where: {
        organizationId_outcomeKey: {
          organizationId: this.organizationId,
          outcomeKey: data.outcomeKey,
        },
      },
      update: {},
      create: {
        ...data,
        organizationId: this.organizationId,
        title: json(data.title),
      },
    });
  }
  suggestions(propertyIds: string[]) {
    return this.tx.automationSuggestion.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: { in: propertyIds },
        status: "OPEN",
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  variance(data: Omit<Prisma.VarianceUncheckedCreateInput, "organizationId">) {
    return this.tx.variance.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }
  reservationPlans(reservationId: string) {
    return this.tx.automationRun.findMany({
      where: {
        organizationId: this.organizationId,
        status: "SUCCEEDED",
        inputs: {
          path: ["fields", "reservation", "id"],
          equals: reservationId,
        },
      },
      select: {
        inputs: true,
        outputs: true,
        rule: { select: { value: true } },
      },
    });
  }
  scheduleEvents(
    occurrences: Array<{ ruleKey: string; propertyId: string; date: string }>,
    now: Date,
  ) {
    if (!occurrences.length) return Promise.resolve([]);
    return this.tx.outboxEvent.createManyAndReturn({
      skipDuplicates: true,
      data: occurrences.map(({ ruleKey, propertyId, date }) => ({
        organizationId: this.organizationId,
        type: "AutomationScheduled",
        payload: { propertyId, ruleKey, date },
        idempotencyKey: `automation-schedule:${ruleKey}:${propertyId}:${date}`,
        occurredAt: now,
      })),
      select: { id: true },
    });
  }
}
