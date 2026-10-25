import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository, type ConfigRuleRecord, type ConfigScopeCandidate, type ResolvedConfigRule } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { inventoryMinimumsKey, inventoryMinimumsSchema } from "@/platform/config/inventory-policy";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { SyncRepository } from "@/modules/reservations/infrastructure/sync-repository";
import { fieldTaskReadWhere } from "@/modules/reservations/infrastructure/field-task-scope";
import { terminalTaskStates } from "@/modules/reservations/domain/operation-task";
import { operationAllowed, requireAssignedOperationTask, taskResource } from "@/modules/reservations/application/operation-service";
import { ReservationAuthorizationError, ReservationNotFoundError, type ReservationAuditMeta } from "@/modules/reservations/application/reservation-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { fieldStocktakePayloadSchema, FieldStocktakeUnavailableError, type FieldStocktakePayload } from "./field-stocktake";
import { decideStocktake } from "@/modules/inventory/domain/stocktake";
import { stocktakeEventDataSchema } from "@/modules/inventory/domain/events";
import { InventoryRepository } from "@/modules/inventory/infrastructure/inventory-repository";

type StocktakeBatch = {
  organizationId: string; actorId: string; transaction: TenantTransaction; now: Date; repository: InventoryRepository;
  tasks: Map<string, { id: string; propertyId: string }>;
  scopes: Map<string, ConfigScopeCandidate[]>; rules: Map<string, ResolvedConfigRule | null>;
  reportedRules: Map<string, ConfigRuleRecord | null>;
};
function actor(ctx: ReservationActorContext) {
  if (ctx.authContext.organizationId !== ctx.organizationId || ctx.authContext.userAccountId !== ctx.actorId || ctx.authContext.personId !== ctx.personId)
    throw new ReservationAuthorizationError();
  operationAllowed(ctx, "view"); operationAllowed(ctx, "edit");
}
export async function prepareFieldStocktakeBatch(ctx: ReservationActorContext, inputs: FieldStocktakePayload[], tx: TenantTransaction, at?: Date): Promise<StocktakeBatch> {
  actor(ctx);
  const repository = new InventoryRepository(tx, ctx.organizationId), operations = new OperationRepository(tx, ctx.organizationId);
  const ids = [...new Set(inputs.map(input => input.taskId))].sort();
  for (const id of ids) await operations.lock(id);
  await new SyncRepository(tx, ctx.organizationId).lockActor(ctx.personId);
  const tasks = await repository.tasks(ids, { AND: [fieldTaskReadWhere(ctx.authContext, at ?? new Date()),
    { assignedToUserAccountId: ctx.actorId, assignedToPersonId: ctx.personId, state: { notIn: [...terminalTaskStates] } }] });
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  await repository.lockBatch(inputs.flatMap(input => { const task = taskMap.get(input.taskId); return task ? [{ propertyId: task.propertyId, itemKey: input.itemKey }] : []; }));
  const now = at ?? new Date(), propertyIds = [...new Set(tasks.map(task => task.propertyId))];
  const scopes = await new ReservationConfigScopeRepository(tx, ctx.organizationId).propertyScopes(propertyIds, now);
  const rules = await new ConfigRuleRepository(tx, ctx.organizationId).resolveScopeGroups(inventoryMinimumsKey, scopes, now, { recordedAt: now });
  return { organizationId: ctx.organizationId, actorId: ctx.actorId, transaction: tx, now, repository, tasks: taskMap, scopes, rules, reportedRules: new Map() };
}

export async function recordFieldStocktakeInTransaction(ctx: ReservationActorContext, raw: FieldStocktakePayload,
  transport: { deviceId: string; clientOpId: string; clientCreatedAt: Date | null }, tx: TenantTransaction, batch: StocktakeBatch, meta: ReservationAuditMeta) {
  actor(ctx);
  if (batch.organizationId !== ctx.organizationId || batch.actorId !== ctx.actorId || batch.transaction !== tx) throw new ReservationAuthorizationError();
  const input = fieldStocktakePayloadSchema.parse(raw), operations = new OperationRepository(tx, ctx.organizationId);
  const task = await operations.task(input.taskId); requireAssignedOperationTask(ctx, task); operationAllowed(ctx, "view", taskResource(task));
  if (task.archivedAt || terminalTaskStates.some(state => state === task.state) || batch.tasks.get(task.id)?.propertyId !== task.propertyId) throw new ReservationNotFoundError();
  const property = await batch.repository.property(task.propertyId); if (!property) throw new ReservationNotFoundError();
  const rule = batch.rules.get(task.propertyId); if (!rule) throw new FieldStocktakeUnavailableError("CATALOG_CHANGED");
  const current = inventoryMinimumsSchema.parse(rule.parsedValue).minimums.find(item => item.item === input.itemKey);
  if (!current || current.category !== "LINEN") throw new FieldStocktakeUnavailableError("ITEM_UNAVAILABLE");
  if (!batch.reportedRules.has(input.catalogRuleId)) batch.reportedRules.set(input.catalogRuleId, await new ConfigRuleRepository(tx, ctx.organizationId).findById(input.catalogRuleId));
  const reported = batch.reportedRules.get(input.catalogRuleId);
  if (!reported || reported.key !== inventoryMinimumsKey || reported.version !== input.catalogVersion || reported.lifecycle === "DRAFT" ||
    reported.effectiveFrom > batch.now || !(batch.scopes.get(task.propertyId) ?? []).some(scope => scope.scopeType === reported.scopeType && scope.scopeId === reported.scopeId))
    throw new FieldStocktakeUnavailableError("CATALOG_CHANGED");
  const prior = inventoryMinimumsSchema.parse(reported.value).minimums.find(item => item.item === input.itemKey);
  if (!prior || prior.category !== "LINEN") throw new FieldStocktakeUnavailableError("CATALOG_CHANGED");
  if ((current.unit ?? null) !== input.unit || (prior.unit ?? null) !== input.unit) throw new FieldStocktakeUnavailableError("UNIT_CHANGED");
  let item = await batch.repository.item(input.itemKey), location = await batch.repository.propertyLocation(task.propertyId);
  if (item?.archivedAt || location?.archivedAt || (item && item.category !== "LINEN")) throw new FieldStocktakeUnavailableError("ITEM_UNAVAILABLE");
  if (item && item.unit !== input.unit) throw new FieldStocktakeUnavailableError("UNIT_CHANGED");
  const position = item && location ? await batch.repository.position(location.id, item.id) : { quantity: "0", revision: "0" };
  const decision = decideStocktake({ expected: { quantity: input.expectedQuantity, revision: input.expectedRevision }, current: position,
    countedQuantity: input.countedQuantity, configuredMinimum: String(current.quantity) });
  const appliedCatalog = { id: rule.id, key: rule.key, version: rule.version, scopeType: rule.scopeType, scopeId: rule.scopeId,
    effectiveFrom: rule.effectiveFrom.toISOString(), effectiveTo: rule.effectiveTo?.toISOString() ?? null };
  const source = { appliedCatalog, reportedCatalog: { id: reported.id, version: reported.version }, scopes: batch.scopes.get(task.propertyId) ?? [],
    item: { key: input.itemKey, category: current.category, unit: input.unit, minimum: String(current.quantity) } };
  const audit = async (action: string, resourceType: string, resourceId: string, after: unknown, before?: unknown) => writeAuditEvent(tx,
    { organizationId: ctx.organizationId, actorId: ctx.actorId, action, resourceType, resourceId, propertyScopeId: task.propertyId,
      before, after, reason: input.note, requestId: meta.requestId, ipAddress: meta.ipAddress ?? null, deviceId: transport.deviceId, occurredAt: batch.now });
  if (!item) {
    const labels = current.name ?? { en: input.itemKey, fr: input.itemKey };
    item = await batch.repository.createItem({ key: input.itemKey, category: "LINEN", unit: input.unit,
      labels, sourceConfigRuleId: rule.id });
    await audit("inventory.item.materialized", "inventory_item", item.id, { key: item.key, category: item.category, unit: item.unit, appliedCatalog });
  }
  if (!location) {
    location = await batch.repository.createPropertyLocation(task.propertyId, property.name);
    await audit("inventory.location.materialized", "inventory_location", location.id, { kind: location.kind, propertyId: task.propertyId });
  }
  const recorded = await batch.repository.record({ propertyId: task.propertyId, taskId: task.id, locationId: location.id, itemId: item.id, actorId: ctx.actorId,
    configRuleId: rule.id, expected: position, countedQuantity: decision.quantity, delta: decision.delta, note: input.note, ...transport,
    configSnapshot: source, receivedAt: batch.now });
  await audit("inventory.stocktake.record", "inventory_stocktake", recorded.observation.id,
    { ...recorded.position, delta: decision.delta, movementId: recorded.movement?.id ?? null, source,
      untrustedClientCreatedAt: transport.clientCreatedAt?.toISOString() ?? null }, position);
  const stocktake = stocktakeEventDataSchema.parse({ id: recorded.observation.id, expected: position.quantity, actual: decision.quantity,
    delta: decision.delta, revision: recorded.position.revision });
  const payload = { propertyId: task.propertyId, taskId: task.id, inventory: { item: input.itemKey, quantity: decision.quantity }, stocktake, configuration: source };
  const outbox = new OutboxRepository(tx, ctx.organizationId);
  if (decision.variance) await outbox.append("StocktakeVariance", payload, `inventory:${recorded.observation.id}:variance`, batch.now);
  if (decision.belowMinimum) await outbox.append("InventoryBelowMinimum", payload, `inventory:${recorded.observation.id}:below-minimum`, batch.now);
  return { stocktakeId: recorded.observation.id, serverVersion: recorded.position.revision };
}
