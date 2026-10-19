import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { checklistCatalogSchema } from "@/platform/config/rule-registry";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { dateToUtc } from "../domain/reservation-task";
import type { z } from "zod";
import type { createTaskSchema } from "../domain/operation-task";
import defaultPolicy from "@/platform/config/defaults/operations.json";
import { operationPolicySchema } from "@/platform/config/operation-policy";

export class OperationRepository {
  constructor(
    readonly tx: TenantTransaction,
    readonly organizationId: string,
  ) {}
  async context(actorId: string, requestId: string, reason: string) {
    await this.tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.task_actor_id', ${actorId}, true), set_config('app.task_request_id', ${requestId}, true), set_config('app.task_reason', ${reason}, true)`,
    );
  }
  async lock(key: string) {
    await this.tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`operation:${this.organizationId}:${key}`}, 0))`,
    );
  }
  task(id: string) {
    return this.tx.operationTask.findFirst({
      where: { organizationId: this.organizationId, id, archivedAt: null },
      include: {
        property: {
          select: {
            id: true,
            name: true,
            timezone: true,
            city: true,
            cityId: true,
            region: true,
            regionId: true,
          },
        },
        checklistItems: { orderBy: { sortOrder: "asc" } },
      },
    });
  }
  property(id: string) {
    return this.tx.property.findFirst({
      where: { organizationId: this.organizationId, id, archivedAt: null },
      select: {
        id: true,
        name: true,
        timezone: true,
        city: true,
        cityId: true,
        region: true,
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
        city: true,
        cityId: true,
        region: true,
        regionId: true,
      },
      orderBy: { name: "asc" },
    });
  }
  async checklists(propertyId: string) {
    const scopes = await new ReservationConfigScopeRepository(
      this.tx,
      this.organizationId,
    ).scopes({ propertyId, asOf: new Date() });
    const rule = await new ConfigRuleRepository(
      this.tx,
      this.organizationId,
    ).resolve({ key: "ops.checklists", scopes });
    return rule
      ? { rule, catalog: checklistCatalogSchema.parse(rule.parsedValue) }
      : null;
  }
  async policy(propertyId: string) {
    const scopes = await new ReservationConfigScopeRepository(
      this.tx,
      this.organizationId,
    ).scopes({ propertyId, asOf: new Date() });
    const repository = new ConfigRuleRepository(this.tx, this.organizationId);
    let rule = await repository.resolve({ key: "ops.task_policy", scopes });
    if (!rule) {
      await this.lock("crew-schedule");
      await this.lock("initial-policy");
      rule = await repository.resolve({ key: "ops.task_policy", scopes });
      if (!rule) {
        await repository.createVersion({
          key: "ops.task_policy",
          scopeType: "organization",
          value: defaultPolicy,
          effectiveFrom: new Date("1970-01-01"),
          reason: "Initial editable Operations policy",
        });
        rule = await repository.resolve({ key: "ops.task_policy", scopes });
      }
    }
    return operationPolicySchema.parse(rule!.parsedValue);
  }
  async team() {
    return this.tx.roleAssignment.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        person: { archivedAt: null },
        role: { archivedAt: null },
      },
      include: {
        person: { select: { id: true, displayName: true } },
        userAccount: { select: { id: true, status: true } },
        role: {
          include: { rolePermissions: { include: { permission: true } } },
        },
      },
    });
  }
  availability(people: string[], from: Date, until: Date) {
    return this.tx.teamAvailability.findMany({
      where: {
        organizationId: this.organizationId,
        personId: { in: people },
        status: "APPROVED",
        startsOn: { lte: until },
        endsOn: { gt: from },
      },
    });
  }
  workloads(from: Date, until: Date, exclude: string[] = []) {
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        state: { notIn: ["COMPLETED", "CANCELLED", "SKIPPED"] },
        id: { notIn: exclude },
        dueDate: { gte: from, lte: until },
      },
      select: {
        id: true,
        assignedToPersonId: true,
        dueDate: true,
        scheduledStart: true,
        scheduledEnd: true,
        property: { select: { timezone: true } },
      },
    });
  }
  async recurring(propertyId: string, asOf = new Date()) {
    const scopes = await new ReservationConfigScopeRepository(
      this.tx,
      this.organizationId,
    ).scopes({ propertyId, asOf });
    return new ConfigRuleRepository(this.tx, this.organizationId).resolve({
      key: "ops.recurring_tasks",
      scopes,
      asOf,
    });
  }
  async policies(propertyIds: string[], asOf: Date) {
    const groups = await new ReservationConfigScopeRepository(
      this.tx,
      this.organizationId,
    ).propertyScopes(propertyIds, asOf);
    return new ConfigRuleRepository(
      this.tx,
      this.organizationId,
    ).resolveScopeGroups("ops.task_policy", groups, asOf);
  }
  readinessTasks(propertyIds: string[], from: Date, until: Date) {
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: { in: propertyIds },
        archivedAt: null,
        OR: [
          {
            state: { notIn: ["COMPLETED", "CANCELLED", "SKIPPED"] },
            dueDate: { lte: until },
          },
          { dueDate: { gte: from, lte: until } },
        ],
      },
      include: {
        property: {
          select: {
            id: true,
            name: true,
            timezone: true,
            city: true,
            cityId: true,
            region: true,
            regionId: true,
          },
        },
        checklistItems: { orderBy: { sortOrder: "asc" } },
      },
    });
  }
  accountPerson(id: string) {
    return this.tx.userAccount.findFirst({
      where: { organizationId: this.organizationId, id, status: "ACTIVE" },
      select: { personId: true },
    });
  }
  scoped(ids: string[]) {
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        id: { in: ids },
        archivedAt: null,
      },
      include: {
        property: {
          select: {
            id: true,
            name: true,
            timezone: true,
            city: true,
            cityId: true,
            region: true,
            regionId: true,
          },
        },
        checklistItems: { orderBy: { sortOrder: "asc" } },
      },
    });
  }
  page(where: Prisma.OperationTaskWhereInput, skip: number, take: number) {
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        AND: [where],
      },
      include: {
        property: {
          select: {
            id: true,
            name: true,
            timezone: true,
            city: true,
            cityId: true,
            region: true,
            regionId: true,
          },
        },
        checklistItems: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      skip,
      take,
    });
  }
  count(where: Prisma.OperationTaskWhereInput) {
    return this.tx.operationTask.count({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        AND: [where],
      },
    });
  }
  workerGroups(where: Prisma.OperationTaskWhereInput) {
    return this.tx.operationTask.groupBy({
      by: ["assignedToPersonId", "propertyId"],
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        assignedToPersonId: { not: null },
        AND: [where],
      },
    });
  }
  views(userAccountId: string) {
    return this.tx.operationSavedView.findMany({
      where: {
        organizationId: this.organizationId,
        userAccountId,
        archivedAt: null,
      },
      orderBy: { name: "asc" },
      take: 100,
    });
  }
  saveView(
    userAccountId: string,
    name: string,
    filters: Prisma.InputJsonValue,
  ) {
    return this.tx.operationSavedView.upsert({
      where: {
        organizationId_userAccountId_name: {
          organizationId: this.organizationId,
          userAccountId,
          name,
        },
      },
      update: { filters, archivedAt: null },
      create: {
        organizationId: this.organizationId,
        userAccountId,
        name,
        filters,
      },
    });
  }
  archiveView(userAccountId: string, id: string) {
    return this.tx.operationSavedView.updateMany({
      where: {
        organizationId: this.organizationId,
        userAccountId,
        id,
        archivedAt: null,
      },
      data: { archivedAt: new Date() },
    });
  }
  evidence(taskId: string) {
    return this.tx.operationTaskEvidence.findMany({
      where: { organizationId: this.organizationId, taskId },
      orderBy: { createdAt: "desc" },
    });
  }
  evidenceById(id: string) {
    return this.tx.operationTaskEvidence.findFirst({
      where: { organizationId: this.organizationId, id },
    });
  }
  addEvidence(
    data: Omit<
      Prisma.OperationTaskEvidenceUncheckedCreateInput,
      "organizationId"
    >,
  ) {
    return this.tx.operationTaskEvidence.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }
  issues(taskId: string) {
    return this.tx.operationIssue.findMany({
      where: { organizationId: this.organizationId, taskId },
      orderBy: { createdAt: "desc" },
    });
  }
  addIssue(
    data: Omit<Prisma.OperationIssueUncheckedCreateInput, "organizationId">,
  ) {
    return this.tx.operationIssue.create({
      data: { ...data, organizationId: this.organizationId },
    });
  }
  async checklistProgress(
    taskId: string,
    ids: string[],
    accountId: string,
    personId: string,
  ) {
    await this.tx.operationTaskChecklistItem.updateMany({
      where: {
        organizationId: this.organizationId,
        taskId,
        id: { notIn: ids },
      },
      data: {
        completedAt: null,
        completedByPersonId: null,
        completedByUserAccountId: null,
      },
    });
    await this.tx.operationTaskChecklistItem.updateMany({
      where: {
        organizationId: this.organizationId,
        taskId,
        id: { in: ids },
        completedAt: null,
      },
      data: {
        completedAt: new Date(),
        completedByPersonId: personId,
        completedByUserAccountId: accountId,
      },
    });
  }
  event(type: string, taskId: string, propertyId: string, key: string) {
    return this.tx.outboxEvent.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey: key,
        },
      },
      update: {},
      create: {
        organizationId: this.organizationId,
        type,
        payload: { taskId, propertyId },
        idempotencyKey: key,
      },
    });
  }
  activeTasks(propertyIds: string[], from?: Date, until?: Date) {
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: { in: propertyIds },
        archivedAt: null,
        state: { notIn: ["COMPLETED", "CANCELLED", "SKIPPED"] },
        ...(from || until ? { dueDate: { gte: from, lte: until } } : {}),
      },
      include: {
        property: {
          select: {
            id: true,
            name: true,
            timezone: true,
            city: true,
            cityId: true,
            region: true,
            regionId: true,
          },
        },
        checklistItems: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
    });
  }
  arrivals(propertyIds: string[], day: Date) {
    return this.tx.reservation.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId: { in: propertyIds },
        archivedAt: null,
        status: { notIn: ["CANCELLED", "NO_SHOW", "CLOSED"] },
        checkIn: day,
      },
      select: { id: true, propertyId: true },
    });
  }
  recurringActors() {
    return this.tx.configRule.findMany({
      where: {
        organizationId: this.organizationId,
        key: "ops.recurring_tasks",
        lifecycle: "ACTIVE",
      },
      select: { createdBy: true, scopeId: true, scopeType: true },
      distinct: ["createdBy", "scopeId", "scopeType"],
    });
  }
  existingOccurrences(propertyId: string, from: Date, until: Date) {
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        propertyId,
        seriesKey: { not: null },
        dueDate: { gte: from, lte: until },
      },
      select: { idempotencyKey: true },
    });
  }
  generationFailure(propertyId: string, key: string, now: Date) {
    return this.tx.outboxEvent.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey: key,
        },
      },
      update: { status: "FAILED", lastError: "operations_generation_failed" },
      create: {
        organizationId: this.organizationId,
        type: "OperationsGenerationFailed",
        payload: { propertyId },
        idempotencyKey: key,
        status: "FAILED",
        lastError: "operations_generation_failed",
        occurredAt: now,
      },
    });
  }
  clearGenerationFailures(propertyId: string) {
    return this.tx.outboxEvent.updateMany({
      where: {
        organizationId: this.organizationId,
        type: "OperationsGenerationFailed",
        status: "FAILED",
        payload: { path: ["propertyId"], equals: propertyId },
      },
      data: { status: "DISPATCHED", processedAt: new Date(), lastError: null },
    });
  }
  generationFailures() {
    return this.tx.outboxEvent.findMany({
      where: {
        organizationId: this.organizationId,
        type: "OperationsGenerationFailed",
        status: "FAILED",
      },
      select: { payload: true },
    });
  }
  async create(input: z.infer<typeof createTaskSchema>, actorId: string) {
    const resolved = await this.checklists(input.propertyId);
    const template = resolved?.catalog.checklists.find(
      (item) => item.key === input.checklistTemplateKey,
    );
    if (!template || !resolved) throw new Error("operation_checklist_missing");
    return this.tx.operationTask.create({
      data: {
        organizationId: this.organizationId,
        propertyId: input.propertyId,
        type: input.type,
        titleTranslations: input.title,
        dueDate: dateToUtc(input.dueDate),
        priority: input.priority,
        checklistTemplateKey: template.key,
        checklistConfigRuleId: resolved.rule.id,
        idempotencyKey: input.idempotencyKey,
        createdBy: actorId,
        checklistItems: {
          create: template.items.map((item, sortOrder) => ({
            organizationId: this.organizationId,
            key: item.key,
            labelTranslations: item.label,
            sortOrder,
          })),
        },
      },
    });
  }
  byKey(key: string) {
    return this.tx.operationTask.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: this.organizationId,
          idempotencyKey: key,
        },
      },
    });
  }
  receipt(key: string) {
    return this.tx.operationTaskMutation.findUnique({
      where: {
        organizationId_key: { organizationId: this.organizationId, key },
      },
    });
  }
  record(
    taskId: string,
    key: string,
    payloadHash: string,
    createdBy: string,
    resultResourceId?: string,
  ) {
    return this.tx.operationTaskMutation.create({
      data: {
        organizationId: this.organizationId,
        taskId,
        key,
        payloadHash,
        createdBy,
        resultResourceId,
      },
    });
  }
  update(id: string, data: Prisma.OperationTaskUncheckedUpdateInput) {
    return this.tx.operationTask.update({
      where: { id, organizationId: this.organizationId },
      data,
    });
  }
  history(taskId: string, beforeVersion?: number) {
    return this.tx.operationTaskEvent.findMany({
      where: {
        organizationId: this.organizationId,
        taskId,
        ...(beforeVersion ? { version: { lt: beforeVersion } } : {}),
      },
      orderBy: { version: "desc" },
      take: 51,
    });
  }
  performer(personId: string) {
    return this.tx.person.findFirst({
      where: {
        organizationId: this.organizationId,
        id: personId,
        archivedAt: null,
      },
    });
  }
  people(ids: string[]) {
    return this.tx.person.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, displayName: true },
    });
  }
  actors(ids: string[]) {
    return this.tx.userAccount.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, person: { select: { id: true, displayName: true } } },
    });
  }
  completeItems(
    taskId: string,
    performer: { personId: string; userAccountId: string | null },
    completedAt: Date,
  ) {
    return this.tx.operationTaskChecklistItem.updateMany({
      where: { organizationId: this.organizationId, taskId },
      data: {
        completedAt,
        completedByPersonId: performer.personId,
        completedByUserAccountId: performer.userAccountId,
      },
    });
  }
}
