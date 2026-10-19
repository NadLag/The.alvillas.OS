import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { createHash } from "node:crypto";
import { normalizedReservationSchema, reservationSyncPolicyKey, reservationSyncPolicySchema, type NormalizedReservation } from "../domain/reservation";
import { Money } from "@/platform/money/money";
import { Prisma } from "@prisma/client";
import type {
  ManualReservationInput,
  OperationTaskChecklistItemSummary,
  OperationTaskSummary,
  FieldTaskSummary,
  ReservationSummary,
  ReservationTaskConfig,
  ReservationTaskTemplate
} from "@/modules/reservations/domain/reservation-task";
import {
  dateToUtc,
  nightsBetween,
  reservationTaskConfigSchema
} from "@/modules/reservations/domain/reservation-task";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import type { ResolvedConfigRule } from "@/platform/config/config-rule-repository";
import { reservationTaskTemplatesConfigKey, checklistCatalogSchema } from "@/platform/config/rule-registry";
import type { TenantTransaction } from "@/platform/db/tenant";

type ReservationWithProperty = Prisma.ReservationGetPayload<{
  include: {
    property: true;
    _count: {
      select: {
        conflicts: true;
      };
    };
  };
}>;

type TaskWithRelations = Prisma.OperationTaskGetPayload<{
  include: {
    property: true;
    reservation: true;
  };
}>;

type FieldTaskWithRelations = Prisma.OperationTaskGetPayload<{
  include: {
    property: true;
    reservation: true;
    checklistItems: {
      orderBy: {
        sortOrder: "asc";
      };
    };
  };
}>;

export type ResolvedReservationTaskConfig = {
  config: ReservationTaskConfig;
  rule: ResolvedConfigRule;
  supportingRules?: ResolvedConfigRule[];
};

function toStringRecord(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function taskTitleJson(template: ReservationTaskTemplate): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(template.title).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function checklistLabelJson(
  item: ReservationTaskTemplate["checklist"][number]
): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(item.label).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function reservationToSummary(reservation: ReservationWithProperty): ReservationSummary {
  return {
    id: reservation.id,
    reference: reservation.reference,
    propertyId: reservation.propertyId,
    propertyName: reservation.property.name,
    city: reservation.property.cityId ?? reservation.property.city,
    region: reservation.property.regionId ?? reservation.property.region,
    guestName: reservation.guestName,
    source: reservation.source as ReservationSummary["source"],
    status: reservation.status,
    checkIn: reservation.checkIn,
    checkOut: reservation.checkOut,
    nights: reservation.nights,
    conflictCount: reservation._count.conflicts,
    createdAt: reservation.createdAt
  };
}

function taskToSummary(task: TaskWithRelations): OperationTaskSummary {
  return {
    id: task.id,
    propertyId: task.propertyId,
    propertyName: task.property.name,
    reservationReference: task.reservation?.reference ?? null,
    guestName: task.reservation?.guestName ?? null,
    type: task.type as OperationTaskSummary["type"],
    state: task.state,
    priority: task.priority,
    dueDate: task.dueDate,
    title: toStringRecord(task.titleTranslations),
    assignedToUserAccountId: task.assignedToUserAccountId,
    completedByUserAccountId: task.completedByUserAccountId,
    completionIdempotencyKey: task.completionIdempotencyKey,
    completedAt: task.completedAt,
    createdAt: task.createdAt
  };
}

function checklistItemToSummary(
  item: FieldTaskWithRelations["checklistItems"][number]
): OperationTaskChecklistItemSummary {
  return {
    id: item.id,
    key: item.key,
    label: toStringRecord(item.labelTranslations),
    completedAt: item.completedAt
  };
}

function fieldTaskToSummary(task: FieldTaskWithRelations): FieldTaskSummary {
  return {
    ...taskToSummary(task),
    checklistItems: task.checklistItems.map(checklistItemToSummary)
  };
}

export class ReservationRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async findProperty(propertyId: string): Promise<{ id: string; name: string; city: string; cityId: string | null; region: string | null; regionId: string | null } | null> {
    return this.tx.property.findFirst({
      where: {
        id: propertyId,
        organizationId: this.organizationId,
        archivedAt: null
      },
      select: {
        id: true,
        name: true, city: true, cityId: true, region: true, regionId: true
      }
    });
  }

  async listPropertyOptions(): Promise<Array<{ id: string; name: string; city: string; cityId: string | null; region: string | null; regionId: string | null }>> {
    return this.tx.property.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ createdAt: "desc" }, { city: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        city: true, cityId: true, region: true, regionId: true
      },
      take: 1000
    });
  }

  async resolveTaskConfig(input: {
    propertyId: string;
    asOf: Date;
  }): Promise<ResolvedReservationTaskConfig | null> {
    const rule = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({
      key: reservationTaskTemplatesConfigKey,
      asOf: input.asOf,
      scopes: [
        { scopeType: "property", scopeId: input.propertyId },
        { scopeType: "organization", scopeId: null }
      ]
    });

    if (!rule) {
      return null;
    }

    const config = reservationTaskConfigSchema.parse(rule.value);
    if (!config.tasks.some(task => task.checklistTemplateKey)) return { config, rule };
    const checklistRule = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({
      key: "ops.checklists", asOf: input.asOf,
      scopes: [{ scopeType: "property", scopeId: input.propertyId }, { scopeType: "organization", scopeId: null }]
    });
    if (!checklistRule) return null;
    const catalog = checklistCatalogSchema.parse(checklistRule.parsedValue);
    for (const task of config.tasks) {
      if (!task.checklistTemplateKey) continue;
      const checklist = catalog.checklists.find(item => item.key === task.checklistTemplateKey);
      if (!checklist) return null;
      task.checklist = checklist.items;
    }
    return { config, rule, supportingRules: [checklistRule] };
  }

  async snapshotTaskConfigRule(input: {
    reservationId: string;
    propertyId: string;
    rule: ResolvedConfigRule;
    resolvedAt: Date;
    createdBy: string;
  }): Promise<void> {
    await new ConfigRuleRepository(this.tx, this.organizationId).snapshotReservationRule({
      reservationId: input.reservationId,
      propertyId: input.propertyId,
      rule: input.rule,
      resolvedAt: input.resolvedAt,
      createdBy: input.createdBy
    });
  }

  async findReservationByIdempotency(idempotencyKey: string): Promise<ReservationSummary | null> {
    const reservation = await this.tx.reservation.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey
        }
      },
      include: {
        property: true,
        _count: {
          select: {
            conflicts: {
              where: {
                status: "OPEN"
              }
            }
          }
        }
      }
    });

    return reservation ? reservationToSummary(reservation) : null;
  }

  async createReservation(input: ManualReservationInput, reference: string, actorId: string, status = "CONFIRMED") {
    const reservation = await this.tx.reservation.create({
      data: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        reference,
        source: input.source,
        externalId: input.externalId,
        status,
        confirmedAt: status === "CONFIRMED" ? new Date() : null,
        guestName: input.guestName,
        guestEmail: input.guestEmail,
        guestPhone: input.guestPhone,
        guestPreferredLocale: input.guestPreferredLocale,
        checkIn: dateToUtc(input.checkIn),
        checkOut: dateToUtc(input.checkOut),
        nights: nightsBetween(input.checkIn, input.checkOut),
        adultCount: input.adultCount,
        childCount: input.childCount,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
        createdBy: actorId
      },
      include: {
        property: true,
        _count: {
          select: {
            conflicts: true
          }
        }
      }
    });

    return reservationToSummary(reservation);
  }

  async listReservations(propertyIds?: string[]): Promise<ReservationSummary[]> {
    const reservations = await this.tx.reservation.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
        , ...(propertyIds ? { propertyId: { in: propertyIds } } : {})
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "desc" }],
      include: {
        property: true,
        _count: {
          select: {
            conflicts: {
              where: {
                status: "OPEN"
              }
            }
          }
        }
      },
      take: 100
    });

    return reservations.map(reservationToSummary);
  }

  async listOverlaps(input: ManualReservationInput, reservationId: string): Promise<ReservationSummary[]> {
    const overlaps = await this.tx.reservation.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        archivedAt: null,
        id: {
          not: reservationId
        },
        status: {
          notIn: ["CANCELLED", "NO_SHOW", "CLOSED"]
        },
        checkIn: {
          lt: dateToUtc(input.checkOut)
        },
        checkOut: {
          gt: dateToUtc(input.checkIn)
        }
      },
      include: {
        property: true,
        _count: {
          select: {
            conflicts: true
          }
        }
      }
    });

    return overlaps.map(reservationToSummary);
  }

  async createConflict(
    reservation: ReservationSummary,
    conflictingReservation: ReservationSummary,
    actorId: string
  ): Promise<{ id: string }> {
    return this.tx.reservationConflict.upsert({
      where: {
        organizationId_reservationId_conflictingReservationId: {
          organizationId: this.organizationId,
          reservationId: reservation.id,
          conflictingReservationId: conflictingReservation.id
        }
      },
      update: {},
      create: {
        organizationId: this.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        conflictingReservationId: conflictingReservation.id,
        reason: "OVERLAPPING_CONFIRMED_RESERVATION",
        status: "OPEN",
        createdBy: actorId
      },
      select: {
        id: true
      }
    });
  }

  async ensureTask(
    reservation: ReservationSummary,
    template: ReservationTaskTemplate,
    actor: { userAccountId: string; personId: string }
  ): Promise<{ task: OperationTaskSummary; created: boolean }> {
    const idempotencyKey = `${reservation.id}:${template.key}`;
    const existing = await this.tx.operationTask.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey
        }
      },
      include: {
        property: true,
        reservation: true
      }
    });

    if (existing) {
      return { task: taskToSummary(existing), created: false };
    }

    const task = await this.tx.operationTask.create({
      data: {
        organizationId: this.organizationId,
        propertyId: reservation.propertyId,
        reservationId: reservation.id,
        type: template.type,
        assignedToUserAccountId: actor.userAccountId,
        assignedToPersonId: actor.personId,
        state: "PLANNED",
        priority: template.priority,
        dueDate: template.due === "CHECK_IN" ? reservation.checkIn : reservation.checkOut,
        titleTranslations: taskTitleJson(template),
        idempotencyKey,
        createdBy: actor.userAccountId,
        checklistItems: {
          create: template.checklist.map((item, index) => ({
            organizationId: this.organizationId,
            key: item.key,
            labelTranslations: checklistLabelJson(item),
            sortOrder: index
          }))
        }
      },
      include: {
        property: true,
        reservation: true
      }
    });

    return { task: taskToSummary(task), created: true };
  }

  async listTasks(): Promise<OperationTaskSummary[]> {
    const tasks = await this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      include: {
        property: true,
        reservation: true
      },
      take: 200
    });

    return tasks.map(taskToSummary);
  }

  async tasksForReservation(reservationId: string): Promise<OperationTaskSummary[]> {
    const tasks = await this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        reservationId,
        archivedAt: null
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      include: {
        property: true,
        reservation: true
      }
    });

    return tasks.map(taskToSummary);
  }

  async listFieldTasks(assignedToUserAccountId: string): Promise<FieldTaskSummary[]> {
    const tasks = await this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        assignedToUserAccountId,
        archivedAt: null,
        state: {
          notIn: ["COMPLETED", "CANCELLED", "SKIPPED"]
        }
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      include: {
        property: true,
        reservation: true,
        checklistItems: {
          orderBy: {
            sortOrder: "asc"
          }
        }
      },
      take: 50
    });

    return tasks.map(fieldTaskToSummary);
  }

  async findAssignedFieldTask(
    taskId: string,
    assignedToUserAccountId: string
  ): Promise<FieldTaskSummary | null> {
    const task = await this.tx.operationTask.findFirst({
      where: {
        id: taskId,
        organizationId: this.organizationId,
        assignedToUserAccountId,
        archivedAt: null
      },
      include: {
        property: true,
        reservation: true,
        checklistItems: {
          orderBy: {
            sortOrder: "asc"
          }
        }
      }
    });

    return task ? fieldTaskToSummary(task) : null;
  }

  async completeFieldTask(
    task: FieldTaskSummary,
    checklistItemIds: string[],
    actor: { userAccountId: string; personId: string },
    idempotencyKey: string
  ): Promise<FieldTaskSummary> {
    const completedAt = new Date();
    const allowedIds = new Set(task.checklistItems.map((item) => item.id));
    const selectedIds = checklistItemIds.filter((id) => allowedIds.has(id));

    if (selectedIds.length !== checklistItemIds.length) {
      throw new Error("Checklist item does not belong to this task");
    }

    await this.tx.operationTaskChecklistItem.updateMany({
      where: {
        organizationId: this.organizationId,
        taskId: task.id,
        id: {
          in: selectedIds
        }
      },
      data: {
        completedAt,
        completedByUserAccountId: actor.userAccountId,
        completedByPersonId: actor.personId
      }
    });

    await this.tx.operationTask.update({
      where: {
        id: task.id
      },
      data: {
        state: "COMPLETED",
        completedAt,
        completedByUserAccountId: actor.userAccountId,
        completedByPersonId: actor.personId,
        completionIdempotencyKey: idempotencyKey
      }
    });

    const completed = await this.findAssignedFieldTask(task.id, actor.userAccountId);

    if (!completed) {
      throw new Error("Completed task could not be reloaded");
    }

    return completed;
  }
  async lockProperty(propertyId: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`reservation:${this.organizationId}:${propertyId}`}, 0))`);
  }
  property(propertyId: string) {
    return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id: propertyId, archivedAt: null }, select: { id: true, name: true, city: true, cityId: true, region: true, regionId: true, timezone: true } });
  }
  reservation(id: string) {
    return this.tx.reservation.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, include: { property: { select: { id: true, name: true, city: true, cityId: true, region: true, regionId: true, timezone: true } } } });
  }
  async guest(input: Pick<NormalizedReservation, "guestName" | "guestEmail" | "guestPhone">, actorId: string) {
    await this.lockGuestMerge();
    const email = input.guestEmail?.toLowerCase() ?? null, phone = input.guestPhone;
    const contact = [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])];
    if (contact.length) {
      // Property locks serialize imports; contact lock also protects concurrent properties.
      for (const key of [email, phone].filter(Boolean).sort()) await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`guest:${this.organizationId}:${key}`}, 0))`);
      const matches = await this.tx.guestRecord.findMany({ where: { organizationId: this.organizationId, OR: contact } });
      const roots = new Map<string, (typeof matches)[number]>();
      for (let record of matches) {
        const visited = new Set<string>();
        while (record.mergedIntoId && !visited.has(record.id)) {
          visited.add(record.id);
          const parent = await this.tx.guestRecord.findFirst({ where: { organizationId: this.organizationId, id: record.mergedIntoId } });
          if (!parent) break;
          record = parent;
        }
        if (!record.archivedAt && !record.mergedIntoId) roots.set(record.id, record);
      }
      if (roots.size === 1) return [...roots.values()][0];
      // Conflicting contacts require an explicit human merge; never guess identity.
    }
    return this.tx.guestRecord.create({ data: { organizationId: this.organizationId, displayName: input.guestName, email, phone, createdBy: actorId } });
  }
  attachGuest(id: string, guestId: string) {
    return this.tx.reservation.update({ where: { id, organizationId: this.organizationId }, data: { guestId } });
  }
  revision(idempotencyKey: string) {
    return this.tx.reservationRevision.findFirst({ where: { organizationId: this.organizationId, idempotencyKey } });
  }
  appendRevision(input: { reservationId: string; version: number; operation: string; before: unknown; after: unknown; reason: string; idempotencyKey: string; actorId: string }) {
    const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
    return this.tx.reservationRevision.create({ data: { organizationId: this.organizationId, reservationId: input.reservationId, version: input.version, operation: input.operation,
      before: json(input.before), after: json(input.after), reason: input.reason, idempotencyKey: input.idempotencyKey, createdBy: input.actorId } });
  }
  updateReservation(id: string, data: Prisma.ReservationUncheckedUpdateInput) {
    return this.tx.reservation.update({ where: { id, organizationId: this.organizationId }, data });
  }
  async financialSnapshot(reservationId: string, version: number, quote: NormalizedReservation["quote"], rules: unknown, actorId: string) {
    const money = quote ? Money.of(quote.amount, quote.currency) : null;
    return this.tx.reservationFinancialSnapshot.create({ data: { organizationId: this.organizationId, reservationId, version,
      amount: money?.toJSON().amount, currency: money?.currency, rules: JSON.parse(JSON.stringify(rules)) as Prisma.InputJsonValue, createdBy: actorId } });
  }
  latestFinancialSnapshot(reservationId: string) {
    return this.tx.reservationFinancialSnapshot.findFirst({ where: { organizationId: this.organizationId, reservationId }, orderBy: { version: "desc" } });
  }
  async resolvedFinancialRules(propertyId: string, asOf: Date, source?: string) {
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    const scopes = await new ReservationConfigScopeRepository(this.tx, this.organizationId).scopes({ propertyId, asOf, source });
    const rules = await Promise.all(["finance.commission", "finance.ota_fee", "finance.expense_treatment", "finance.approval_thresholds", "finance.payout_schedule", "finance.tax"].map(key => config.resolve({ key, asOf, scopes })));
    return rules.filter(rule => rule !== null).map(rule => ({ id: rule.id, key: rule.key, version: rule.version, scopeType: rule.scopeType, scopeId: rule.scopeId, effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo, value: rule.parsedValue }));
  }
  async exception(propertyId: string, reservationId: string | null, kind: string, key: string, details: unknown, actorId: string | null) {
    return this.tx.reservationException.upsert({ where: { organizationId_key: { organizationId: this.organizationId, key } },
      update: { status: "OPEN", details: JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue, resolution: null },
      create: { organizationId: this.organizationId, propertyId, reservationId, kind, key, details: JSON.parse(JSON.stringify(details)) as Prisma.InputJsonValue, createdBy: actorId } });
  }
  async sourceMatch(propertyId: string, entry: NormalizedReservation) {
    return this.tx.reservation.findFirst({ where: { organizationId: this.organizationId, propertyId, source: entry.source, archivedAt: null,
      ...(entry.externalId ? { externalId: entry.externalId } : { externalId: null, checkIn: dateToUtc(entry.checkIn), checkOut: dateToUtc(entry.checkOut) }) } });
  }
  duplicateCandidates(propertyId: string, entry: NormalizedReservation) {
    return this.tx.reservation.findMany({ where: { organizationId: this.organizationId, propertyId, archivedAt: null,
      checkIn: dateToUtc(entry.checkIn), checkOut: dateToUtc(entry.checkOut), status: { notIn: ["CANCELLED", "NO_SHOW"] } }, take: 30 });
  }
  async reconcileTasks(reservationId: string, actorId: string, reason: string) {
    const changes: Array<{ id: string; before: { state: string; dueDate: Date }; after: { state: string; dueDate: Date }; reason: string }> = [];
    const reservation = await this.reservation(reservationId);
    if (!reservation) throw new Error("reservation_missing");
    const tasks = await this.tx.operationTask.findMany({ where: { organizationId: this.organizationId, reservationId, archivedAt: null } });
    if (!tasks.length) return changes;
    const frozen = await this.tx.reservationConfigSnapshot.findUnique({ where: { organizationId_reservationId_key: { organizationId: this.organizationId, reservationId, key: reservationTaskTemplatesConfigKey } } });
    const envelope = frozen?.snapshotValue;
    const frozenValue = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope.value : null;
    const config = frozenValue ? reservationTaskConfigSchema.parse(frozenValue) : (await this.resolveTaskConfig({ propertyId: reservation.propertyId, asOf: reservation.confirmedAt ?? reservation.createdAt }))?.config;
    if (!config) throw new Error("reservation_task_configuration_missing");
    const cancelled = ["CANCELLED", "NO_SHOW"].includes(reservation.status);
    for (const task of tasks) {
      if (["COMPLETED", "SKIPPED", "CANCELLED"].includes(task.state)) continue;
      const template = config.tasks.find(item => task.idempotencyKey === `${reservationId}:${item.key}`);
      if (!template) continue;
      const dueDate = template.due === "CHECK_IN" ? reservation.checkIn : reservation.checkOut;
      if (task.state === "IN_PROGRESS" && !cancelled && task.dueDate.getTime() !== dueDate.getTime()) {
        await this.exception(reservation.propertyId, reservationId, "TASK_REVIEW", `task-change:${task.id}`, { taskId: task.id, dueDate }, actorId); continue;
      }
      const state = cancelled ? "CANCELLED" : task.state;
      if (state !== task.state || dueDate.getTime() !== task.dueDate.getTime()) {
        await this.tx.operationTask.update({ where: { id: task.id, organizationId: this.organizationId }, data: { state, dueDate } });
        changes.push({ id: task.id, before: { state: task.state, dueDate: task.dueDate }, after: { state, dueDate }, reason });
      }
    }
    return changes;
  }
  async generateConfirmationTasks(reservationId: string, actorId: string, personId: string) {
    const reservation = await this.reservation(reservationId);
    if (!reservation) throw new Error("reservation_missing");
    const config = await this.resolveTaskConfig({ propertyId: reservation.propertyId, asOf: reservation.confirmedAt ?? reservation.createdAt });
    if (!config) throw new Error("reservation_task_configuration_missing");
    for (const rule of [config.rule, ...(config.supportingRules ?? [])]) await this.snapshotTaskConfigRule({ reservationId, propertyId: reservation.propertyId, rule, resolvedAt: reservation.confirmedAt ?? reservation.createdAt, createdBy: actorId });
    const summary: ReservationSummary = { ...reservation, propertyName: reservation.property.name, source: reservation.source as ReservationSummary["source"], conflictCount: 0 };
    const created = [];
    for (const template of config.config.tasks) { const result = await this.ensureTask(summary, template, { userAccountId: actorId, personId }); if (result.created) created.push(result.task); }
    return created;
  }
  async feedPolicy(propertyId: string, asOf: Date) {
    const rule = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({ key: reservationSyncPolicyKey, asOf, scopes: [{ scopeType: "property", scopeId: propertyId }, { scopeType: "organization", scopeId: null }] });
    if (!rule) throw new Error("reservation_sync_policy_missing");
    return reservationSyncPolicySchema.parse(rule.parsedValue);
  }
  createFeed(input: { propertyId: string; source: string; name: string; bookingChannelId: string; idempotencyKey: string }, actorId: string) {
    return this.tx.reservationFeed.upsert({ where: { organizationId_bookingChannelId: { organizationId: this.organizationId, bookingChannelId: input.bookingChannelId } }, update: { name: input.name, enabled: true, nextSyncAt: new Date() }, create: { organizationId: this.organizationId, ...input, createdBy: actorId } });
  }
  feed(id: string) { return this.tx.reservationFeed.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, include: { channel: { select: { syncEndpointEncrypted: true, status: true, importEnabled: true, syncMode: true } } } }); }

  async claimFeed(id: string, now: Date) {
    const token = crypto.randomUUID();
    const result = await this.tx.reservationFeed.updateMany({ where: { organizationId: this.organizationId, id, enabled: true, archivedAt: null, OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] }, data: { leaseToken: token, leasedUntil: new Date(now.getTime() + 120000), lastAttemptAt: now } });
    return result.count ? token : null;
  }
  updateFeed(id: string, data: Prisma.ReservationFeedUncheckedUpdateInput) { return this.tx.reservationFeed.update({ where: { organizationId: this.organizationId, id }, data }); }
  feedEntries(feedId: string) { return this.tx.reservationFeedEntry.findMany({ where: { organizationId: this.organizationId, feedId } }); }
  recordFeedEntry(feedId: string, externalKey: string, data: { reservationId: string | null; blockId: string | null; contentHash: string; sequence: number | null; lastSeenAt: Date }) {
    return this.tx.reservationFeedEntry.upsert({ where: { organizationId_feedId_externalKey: { organizationId: this.organizationId, feedId, externalKey } }, update: { ...data, missingRuns: 0 }, create: { organizationId: this.organizationId, feedId, externalKey, ...data } });
  }
  missingFeedEntry(id: string) { return this.tx.reservationFeedEntry.update({ where: { organizationId: this.organizationId, id }, data: { missingRuns: { increment: 1 } } }); }
  syncRun(feedId: string, status: string, counts: { imported: number; modified: number; suspected: number }, errorCode: string | null, actorId: string | null) {
    return this.tx.feedSyncRun.create({ data: { organizationId: this.organizationId, feedId, status, ...counts, errorCode, createdBy: actorId } });
  }
  dueFeeds(now: Date) { return this.tx.reservationFeed.findMany({ where: { organizationId: this.organizationId, enabled: true, archivedAt: null, channel: { status: "ACTIVE", importEnabled: true, syncMode: "ICAL", archivedAt: null }, nextSyncAt: { lte: now } }, orderBy: { nextSyncAt: "asc" }, take: 100 }); }
  createBlock(input: { propertyId: string; source: string; kind: string; checkIn: string; checkOut: string; reason?: string; externalId?: string | null; idempotencyKey: string }, actorId: string) {
    return this.tx.calendarBlock.upsert({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey: input.idempotencyKey } }, update: {}, create: { ...input, organizationId: this.organizationId, checkIn: dateToUtc(input.checkIn), checkOut: dateToUtc(input.checkOut), createdBy: actorId } });
  }
  block(id: string) { return this.tx.calendarBlock.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null } }); }
  sourceBlock(propertyId: string, entry: NormalizedReservation) {
    return this.tx.calendarBlock.findFirst({ where: { organizationId: this.organizationId, propertyId, source: entry.source, kind: "OTA", archivedAt: null, ...(entry.externalId ? { externalId: entry.externalId } : { externalId: null, checkIn: dateToUtc(entry.checkIn), checkOut: dateToUtc(entry.checkOut) }) } });
  }
  updateBlock(id: string, data: Prisma.CalendarBlockUncheckedUpdateInput) { return this.tx.calendarBlock.update({ where: { id, organizationId: this.organizationId }, data }); }
  async refreshConflicts(propertyId: string, actorId: string) {
    const reservations = await this.tx.reservation.findMany({ where: { organizationId: this.organizationId, propertyId, archivedAt: null, status: { notIn: ["CANCELLED", "NO_SHOW", "IMPORTED"] } }, orderBy: { checkIn: "asc" } });
    const open = await this.tx.reservationConflict.findMany({ where: { organizationId: this.organizationId, propertyId, status: "OPEN" } });
    const active = new Set<string>();
    for (let i = 0; i < reservations.length; i++) for (let j = i + 1; j < reservations.length && reservations[j].checkIn < reservations[i].checkOut; j++) {
      const [left, right] = [reservations[i], reservations[j]].sort((a, b) => a.id.localeCompare(b.id));
      active.add(`${left.id}:${right.id}`);
      const existing = open.find(c => (c.reservationId === left.id && c.conflictingReservationId === right.id) || (c.reservationId === right.id && c.conflictingReservationId === left.id));
      if (existing) { await this.exception(propertyId, left.id, "DOUBLE_BOOKING", `overlap:${left.id}:${right.id}`, { conflictId: existing.id, reservationIds: [left.id, right.id] }, actorId); continue; }
      const conflict = await this.tx.reservationConflict.upsert({ where: { organizationId_reservationId_conflictingReservationId: { organizationId: this.organizationId, reservationId: left.id, conflictingReservationId: right.id } }, update: { status: "OPEN" }, create: { organizationId: this.organizationId, propertyId, reservationId: left.id, conflictingReservationId: right.id, reason: "OVERLAPPING_CONFIRMED_RESERVATION", createdBy: actorId } });
      await this.exception(propertyId, left.id, "DOUBLE_BOOKING", `overlap:${left.id}:${right.id}`, { conflictId: conflict.id, reservationIds: [left.id, right.id] }, actorId);
    }
    for (const conflict of open) {
      const key = [conflict.reservationId, conflict.conflictingReservationId].sort().join(":");
      if (!active.has(key)) {
        await this.tx.reservationConflict.update({ where: { organizationId: this.organizationId, id: conflict.id }, data: { status: "RESOLVED" } });
        await this.tx.reservationException.updateMany({ where: { organizationId: this.organizationId, key: `overlap:${key}`, status: "OPEN" }, data: { status: "RESOLVED", resolution: "Dates or lifecycle no longer overlap", resolvedBy: actorId } });
      }
    }
    const blocks = await this.tx.calendarBlock.findMany({ where: { organizationId: this.organizationId, propertyId, status: "ACTIVE", archivedAt: null } });
    const activeBlocks = new Set<string>();
    for (const block of blocks) for (const reservation of reservations) if (reservation.checkIn < block.checkOut && reservation.checkOut > block.checkIn) {
      const key = `block:${block.id}:${reservation.id}`; activeBlocks.add(key);
      await this.exception(propertyId, reservation.id, "BLOCK_OVERLAP", key, { blockId: block.id, kind: block.kind }, actorId);
    }
    const blockExceptions = await this.tx.reservationException.findMany({ where: { organizationId: this.organizationId, propertyId, kind: "BLOCK_OVERLAP", status: "OPEN" } });
    for (const exception of blockExceptions) if (!activeBlocks.has(exception.key)) await this.tx.reservationException.update({ where: { id: exception.id, organizationId: this.organizationId }, data: { status: "RESOLVED", resolution: "Block no longer overlaps", resolvedBy: actorId } });
  }
  batch(propertyId: string, source: string, contentHash: string, idempotencyKey: string) {
    return this.tx.reservationImportBatch.findFirst({ where: { organizationId: this.organizationId, OR: [{ propertyId, source, contentHash }, { idempotencyKey }] } });
  }
  createBatch(data: { propertyId: string; source: string; contentHash: string; idempotencyKey: string; imported: number; modified: number; duplicates: number }, actorId: string) {
    return this.tx.reservationImportBatch.create({ data: { organizationId: this.organizationId, ...data, createdBy: actorId } });
  }
  async workspace(propertyIds: string[], start: Date, end: Date, page: number, visibility: Prisma.ReservationWhereInput = {}, propertyWideIds: string[] = propertyIds, feedPage = 1) {
    const where = { organizationId: this.organizationId, propertyId: { in: propertyIds }, archivedAt: null, checkIn: { lt: end }, checkOut: { gt: start }, AND: visibility };
    const [reservations, total, blocks, feeds, exceptions, batches, blockTotal, feedTotal] = await Promise.all([
      this.tx.reservation.findMany({ where, orderBy: [{ checkIn: "asc" }, { id: "asc" }], skip: (page - 1) * 50, take: 50, include: { property: { select: { name: true, timezone: true, city: true, cityId: true, region: true, regionId: true } } } }),
      this.tx.reservation.count({ where }),
      this.tx.calendarBlock.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyWideIds }, archivedAt: null, checkIn: { lt: end }, checkOut: { gt: start }, status: "ACTIVE" }, orderBy: [{ checkIn: "asc" }, { id: "asc" }], skip: (page - 1) * 50, take: 50 }),
      this.tx.reservationFeed.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyWideIds }, archivedAt: null }, select: { id: true, propertyId: true, source: true, name: true, enabled: true, lastSuccessAt: true, nextSyncAt: true, lastAttemptAt: true, consecutiveFailures: true, lastError: true, channel: { select: { status: true, importEnabled: true, syncMode: true } } }, orderBy: [{ name: "asc" }, { id: "asc" }], skip: (feedPage - 1) * 50, take: 50 }),
      this.tx.reservationException.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyIds }, status: "OPEN", OR: [{ reservationId: null, propertyId: { in: propertyWideIds } }, { linkedreservationId: { is: visibility } }] }, orderBy: { createdAt: "desc" }, take: 100 }),
      this.tx.reservationImportBatch.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyWideIds } }, orderBy: { createdAt: "desc" }, take: 10 }),
      this.tx.calendarBlock.count({ where: { organizationId: this.organizationId, propertyId: { in: propertyWideIds }, archivedAt: null, status: "ACTIVE", checkIn: { lt: end }, checkOut: { gt: start } } }),
      this.tx.reservationFeed.count({ where: { organizationId: this.organizationId, propertyId: { in: propertyWideIds }, archivedAt: null } })
    ]);
    // One bounded query derives turnovers across page boundaries.
    const neighbors = await this.tx.reservation.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyIds }, archivedAt: null, status: { notIn: ["IMPORTED", "CANCELLED", "NO_SHOW"] }, checkIn: { lte: end }, checkOut: { gte: start }, AND: visibility }, select: { id: true, propertyId: true, checkIn: true, checkOut: true }, orderBy: { checkIn: "asc" } });
    const departures = new Map<string, string[]>();
    for (const r of neighbors) { const key = `${r.propertyId}:${r.checkOut.toISOString()}`; departures.set(key, [...(departures.get(key) ?? []), r.id]); }
    const turnovers = neighbors.flatMap(r => (departures.get(`${r.propertyId}:${r.checkIn.toISOString()}`) ?? []).filter(id => id !== r.id).map(id => ({ propertyId: r.propertyId, date: r.checkIn, departureId: id, arrivalId: r.id })));
    const policies = await new ConfigRuleRepository(this.tx, this.organizationId).resolveForProperties(reservationSyncPolicyKey, propertyIds, new Date());
    const feedHealth = feeds.map(feed => {
      const rule = policies.get(feed.propertyId), policy = rule ? reservationSyncPolicySchema.parse(rule.parsedValue) : null;
      return { ...feed, enabled: feed.enabled && feed.channel.status === "ACTIVE" && feed.channel.importEnabled && feed.channel.syncMode === "ICAL", stale: !policy || !feed.lastSuccessAt || Date.now() - feed.lastSuccessAt.getTime() > policy.stale_after_minutes * 60000 };
    });
    return { reservations, total, blocks, blockTotal, feeds: feedHealth, feedTotal, exceptions, batches, turnovers };
  }
  async history(reservationId: string) {
    const [revisions, financialSnapshots, feedEntries] = await Promise.all([
      this.tx.reservationRevision.findMany({ where: { organizationId: this.organizationId, reservationId }, orderBy: { version: "desc" }, take: 50 }),
      this.tx.reservationFinancialSnapshot.findMany({ where: { organizationId: this.organizationId, reservationId }, orderBy: { version: "desc" }, take: 50 }),
      this.tx.reservationFeedEntry.findMany({ where: { organizationId: this.organizationId, reservationId }, select: { id: true, missingRuns: true, lastSeenAt: true } })
    ]);
    return { revisions, financialSnapshots, feedEntries };
  }
  resolveException(id: string, actorId: string, resolution: string) { return this.tx.reservationException.update({ where: { organizationId: this.organizationId, id }, data: { status: "RESOLVED", resolution, resolvedBy: actorId } }); }
  exceptionById(id: string) { return this.tx.reservationException.findFirst({ where: { organizationId: this.organizationId, id } }); }
  async mergeGuests(fromId: string, toId: string) {
    await this.tx.reservation.updateMany({ where: { organizationId: this.organizationId, guestId: fromId }, data: { guestId: toId } });
    return this.tx.guestRecord.update({ where: { organizationId: this.organizationId, id: fromId }, data: { mergedIntoId: toId, archivedAt: new Date() } });
  }
  guestRecord(id: string) { return this.tx.guestRecord.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null, mergedIntoId: null } }); }
  async lockGuestMerge() { await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`guest-merge:${this.organizationId}`}, 0))`); }
  guestCandidates(id: string, search: string) { return this.tx.guestRecord.findMany({ where: { organizationId: this.organizationId, id: { not: id }, archivedAt: null, mergedIntoId: null, OR: [{ displayName: { contains: search, mode: "insensitive" } }, { email: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }] }, select: { id: true, displayName: true, email: true }, orderBy: { displayName: "asc" }, take: 20 }); }
  guestHistory(guestId: string) { return this.tx.reservation.findMany({ where: { organizationId: this.organizationId, guestId, archivedAt: null }, orderBy: { checkIn: "desc" }, take: 100 }); }
  hasFinancialExceptions(reservationId: string) { return this.tx.reservationException.count({ where: { organizationId: this.organizationId, reservationId, status: "OPEN", kind: { startsWith: "FINANCIAL" } } }); }
  resolveExceptionKey(key: string, actorId: string, resolution: string) { return this.tx.reservationException.updateMany({ where: { organizationId: this.organizationId, key, status: "OPEN" }, data: { status: "RESOLVED", resolvedBy: actorId, resolution } }); }
  feedCreator(id: string) { return this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id }, select: { personId: true, status: true } }); }
  queueChange(reservationId: string, version: number, operation: string) { return this.tx.outboxEvent.upsert({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey: `reservation:${reservationId}:${version}` } }, update: {}, create: { organizationId: this.organizationId, type: "reservation.changed", payload: { reservationId, version, operation }, idempotencyKey: `reservation:${reservationId}:${version}` } }); }
  feedEntry(id: string) { return this.tx.reservationFeedEntry.findFirst({ where: { organizationId: this.organizationId, id } }); }
  suppressFeedEntry(id: string) { return this.tx.reservationFeedEntry.update({ where: { organizationId: this.organizationId, id }, data: { suppressed: true } }); }
  async releaseMissingForReservation(reservationId: string, actorId: string, reason: string) {
    await this.tx.reservationException.updateMany({ where: { organizationId: this.organizationId, reservationId, kind: "MISSING_FEED_ENTRY", status: "OPEN" }, data: { status: "RESOLVED", resolvedBy: actorId, resolution: reason } });
  }
  commandExceptions(propertyIds: string[], visibility: Prisma.ReservationWhereInput = {}, propertyWideIds: string[] = propertyIds) { return this.tx.reservationException.findMany({ where: { organizationId: this.organizationId, propertyId: { in: propertyIds }, status: "OPEN", OR: [{ reservationId: null, propertyId: { in: propertyWideIds } }, { linkedreservationId: { is: visibility } }] }, orderBy: { createdAt: "desc" }, select: { id: true, propertyId: true, reservationId: true, kind: true }, take: 10 }); }
  scopedReservations(ids: string[]) { return this.tx.reservation.findMany({ where: { organizationId: this.organizationId, id: { in: ids }, archivedAt: null }, select: { id: true, propertyId: true, status: true, property: { select: { city: true, cityId: true, region: true, regionId: true } } } }); }
}

export function normalizedHash(entry: NormalizedReservation) {
  return createHash("sha256").update(JSON.stringify(normalizedReservationSchema.parse(entry))).digest("hex");
}
export function externalKey(entry: NormalizedReservation) {
  return entry.externalId ?? `dates:${entry.kind}:${entry.checkIn}:${entry.checkOut}`;
}
