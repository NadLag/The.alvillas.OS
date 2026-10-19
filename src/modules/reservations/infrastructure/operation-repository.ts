import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { checklistCatalogSchema } from "@/platform/config/rule-registry";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { dateToUtc } from "../domain/reservation-task";
import type { z } from "zod";
import type { createTaskSchema } from "../domain/operation-task";

export class OperationRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}
  async context(actorId: string, requestId: string, reason: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT set_config('app.task_actor_id', ${actorId}, true), set_config('app.task_request_id', ${requestId}, true), set_config('app.task_reason', ${reason}, true)`);
  }
  async lock(key: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`operation:${this.organizationId}:${key}`}, 0))`);
  }
  task(id: string) {
    return this.tx.operationTask.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, include: {
      property: { select: { id: true, name: true, timezone: true, city: true, cityId: true, region: true, regionId: true } },
      checklistItems: { orderBy: { sortOrder: "asc" } }
    } });
  }
  property(id: string) {
    return this.tx.property.findFirst({ where: { organizationId: this.organizationId, id, archivedAt: null }, select: { id: true, name: true, timezone: true, city: true, cityId: true, region: true, regionId: true } });
  }
  properties() {
    return this.tx.property.findMany({ where: { organizationId: this.organizationId, archivedAt: null }, select: { id: true, name: true, timezone: true, city: true, cityId: true, region: true, regionId: true }, orderBy: { name: "asc" } });
  }
  async checklists(propertyId: string) {
    const scopes = await new ReservationConfigScopeRepository(this.tx, this.organizationId).scopes({ propertyId, asOf: new Date() });
    const rule = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({ key: "ops.checklists", scopes });
    return rule ? { rule, catalog: checklistCatalogSchema.parse(rule.parsedValue) } : null;
  }
  async create(input: z.infer<typeof createTaskSchema>, actorId: string) {
    const resolved = await this.checklists(input.propertyId);
    const template = resolved?.catalog.checklists.find(item => item.key === input.checklistTemplateKey);
    if (!template || !resolved) throw new Error("operation_checklist_missing");
    return this.tx.operationTask.create({ data: {
      organizationId: this.organizationId, propertyId: input.propertyId, type: input.type,
      titleTranslations: input.title, dueDate: dateToUtc(input.dueDate), priority: input.priority,
      checklistTemplateKey: template.key, checklistConfigRuleId: resolved.rule.id,
      idempotencyKey: input.idempotencyKey, createdBy: actorId,
      checklistItems: { create: template.items.map((item, sortOrder) => ({ organizationId: this.organizationId, key: item.key, labelTranslations: item.label, sortOrder })) }
    } });
  }
  byKey(key: string) { return this.tx.operationTask.findUnique({ where: { organizationId_idempotencyKey: { organizationId: this.organizationId, idempotencyKey: key } } }); }
  receipt(key: string) { return this.tx.operationTaskMutation.findUnique({ where: { organizationId_key: { organizationId: this.organizationId, key } } }); }
  record(taskId: string, key: string, payloadHash: string, createdBy: string) {
    return this.tx.operationTaskMutation.create({ data: { organizationId: this.organizationId, taskId, key, payloadHash, createdBy } });
  }
  update(id: string, data: Prisma.OperationTaskUncheckedUpdateInput) { return this.tx.operationTask.update({ where: { id, organizationId: this.organizationId }, data }); }
  history(taskId: string, beforeVersion?: number) {
    return this.tx.operationTaskEvent.findMany({ where: { organizationId: this.organizationId, taskId, ...(beforeVersion ? { version: { lt: beforeVersion } } : {}) }, orderBy: { version: "desc" }, take: 51 });
  }
  performer(personId: string) { return this.tx.person.findFirst({ where: { organizationId: this.organizationId, id: personId, archivedAt: null } }); }
  people(ids: string[]) { return this.tx.person.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true, displayName: true } }); }
  actors(ids: string[]) { return this.tx.userAccount.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true, person: { select: { id: true, displayName: true } } } }); }
  completeItems(taskId: string, performer: { personId: string; userAccountId: string | null }, completedAt: Date) {
    return this.tx.operationTaskChecklistItem.updateMany({ where: { organizationId: this.organizationId, taskId }, data: { completedAt, completedByPersonId: performer.personId, completedByUserAccountId: performer.userAccountId } });
  }
}
