import { createHash } from "node:crypto";
import { authorize, authorizeCollection, type Resource } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { calendarDateAt } from "@/i18n/format";
import { ConfigRuleRepository, type ResolvedConfigRule } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { fieldDevicePolicyKey, fieldDevicePolicySnapshot } from "@/platform/config/field-device-policy";
import { fieldPullInputSchema, fieldPullPageSize, fieldWorkSnapshotSchema, type FieldPullInput, type FieldPullResult, type FieldWorkSnapshot } from "../domain/field-pull";
import { FieldPullRepository, type FieldPullMetadata, type FieldPullSnapshotRecord } from "../infrastructure/field-pull-repository";
import { fieldTaskReadWhere } from "../infrastructure/field-task-scope";
import { toStringRecord } from "../infrastructure/reservation-repository";
import type { ReservationActorContext } from "./reservation-access";
import { decodeFieldPullCursor, encodeFieldPullCursor, FieldPullError, newFieldPullCursor } from "./field-pull-cursor";
import { fieldStockSnapshots } from "@/platform/inventory/field-stock-snapshot";
import type { FieldLinenSnapshot } from "@/platform/inventory/field-stocktake";

type Deps = { db?: TenantTransactionRunner; now?: Date; env?: NodeJS.ProcessEnv };
function resource(ctx: ReservationActorContext, row: FieldPullMetadata, now: Date): Resource {
  return { type: "task", organizationId: ctx.organizationId, id: row.id, taskId: row.id, jobId: row.id,
    propertyId: row.propertyId, reservationId: row.reservationId, city: row.property.cityId ?? row.property.city,
    region: row.property.regionId ?? row.property.region, status: row.state, assignedUserAccountId: row.assignedToUserAccountId,
    assignedPersonId: row.assignedToPersonId, occurredAt: now };
}
export async function pullFieldWork(ctx: ReservationActorContext, raw: FieldPullInput, deps: Deps = {}): Promise<FieldPullResult> {
  const input = fieldPullInputSchema.parse(raw), now = deps.now ?? new Date();
  if (input.organization_id !== ctx.organizationId || input.actor_user_id !== ctx.actorId ||
    ctx.authContext.organizationId !== ctx.organizationId || ctx.authContext.userAccountId !== ctx.actorId ||
    !authorizeCollection(ctx.authContext, "view", "task") || (input.mode === "supervised" &&
      (!authorizeCollection(ctx.authContext, "validate", "task") || !fieldTaskReadWhere(ctx.authContext, now).OR?.length ||
        !fieldTaskReadWhere(ctx.authContext, now, "validate").OR?.length))) throw new FieldPullError("forbidden");
  const previous = input.cursor ? decodeFieldPullCursor(input.cursor, ctx, input, now, deps.env) : null;
  if (input.only_known && !previous) throw new FieldPullError("invalid_cursor");
  const frame = previous && (previous.kind === "page" || input.only_known) ? previous : newFieldPullCursor(ctx, input, now);
  const asOf = new Date(frame.asOf), known = new Map(input.known_tasks.map(item => [item.id, item.revision]));
  const days = new Map<string, string>();
  const devicePolicies = new Map<string, ResolvedConfigRule | null>();
  let stockSnapshots = new Map<string, { linen: FieldLinenSnapshot; inventory: FieldLinenSnapshot }>();
  const businessDate = (zone: string) => {
    const existing = days.get(zone); if (existing) return existing;
    const date = calendarDateAt(asOf, zone); days.set(zone, date); return date;
  };
  const visibility = (row: FieldPullMetadata) => {
    const task = resource(ctx, row, now);
    const canGuest = authorize(ctx.authContext, "view", { ...task, type: "guest", status: undefined, id: row.reservation?.guestId ?? undefined }, now);
    const canEdit = input.mode !== "supervised" && authorize(ctx.authContext, "edit", task, now), date = businessDate(row.property.timezone);
    const canPerformer = input.mode === "supervised" && Boolean(row.assignedToPersonId) &&
      authorize(ctx.authContext, "view", { ...task, type: "team_member", id: row.assignedToPersonId ?? undefined }, now);
    const devicePolicy = input.include_device_policy ? fieldDevicePolicySnapshot(devicePolicies.get(row.propertyId) ?? null) : undefined;
    const canCount = canEdit && row.assignedToUserAccountId === ctx.actorId && row.assignedToPersonId === ctx.personId;
    const stock = (surface: "linen" | "inventory") => {
      const source = stockSnapshots.get(row.propertyId)?.[surface];
      return source ? { ...source, items: source.items.map(item => ({ ...item, available: item.available && canCount })) } : undefined;
    };
    const linen = input.include_linen ? stock("linen") : undefined, inventory = input.include_inventory ? stock("inventory") : undefined;
    const revision = createHash("sha256").update(JSON.stringify({ task: row.updatedAt.toISOString(),
      property: row.property.updatedAt.toISOString(), reservation: row.reservation?.updatedAt.toISOString() ?? null,
      scope: frame.scope, date, canGuest, canEdit,
      proxy: input.mode === "supervised" ? { version: row.version, performedBy: row.assignedToPersonId,
        person: canPerformer ? row.assignedToPerson?.updatedAt.toISOString() : null } : null,
      devicePolicy, linen, inventory })).digest("base64url");
    return { task, canGuest, canEdit, canPerformer, date, revision, devicePolicy, linen, inventory };
  };
  const allowed = (row: FieldPullMetadata) => authorize(ctx.authContext, "view", resource(ctx, row, now), now) &&
    (input.mode !== "supervised" || (row.assignedToPersonId !== null && row.assignedToPersonId !== ctx.personId &&
      row.assignedToUserAccountId !== ctx.actorId && row.assignedToPerson?.archivedAt === null &&
      ["ASSIGNED", "IN_PROGRESS"].includes(row.state) && authorize(ctx.authContext, "validate", resource(ctx, row, now), now)));
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repo = new FieldPullRepository(tx, ctx.organizationId);
    const candidates = input.only_known ? [] : await repo.page(ctx.actorId, ctx.authContext, now, asOf, input, frame.after);
    const page = candidates.slice(0, fieldPullPageSize), hasMore = candidates.length > fieldPullPageSize;
    const knownRows = input.known_tasks.length ? await repo.known(ctx.actorId, ctx.authContext, now, [...known.keys()], input.mode) : [];
    const dataRows = page.filter(row => allowed(row) && (input.mode !== "today" || row.dueDate.toISOString().slice(0, 10) <= businessDate(row.property.timezone)));
    const eligibleKnown = knownRows.filter(allowed);
    if ((input.include_linen || input.include_inventory) && (dataRows.length || eligibleKnown.length)) {
      stockSnapshots = await fieldStockSnapshots(tx, ctx.organizationId, [...dataRows, ...eligibleKnown].map(row => row.propertyId), asOf);
    }
    if (input.include_device_policy && (dataRows.length || eligibleKnown.length)) {
      const propertyIds = [...new Set([...dataRows, ...eligibleKnown].map(row => row.propertyId))];
      const scopes = await new ReservationConfigScopeRepository(tx, ctx.organizationId).propertyScopes(propertyIds, asOf);
      const resolved = await new ConfigRuleRepository(tx, ctx.organizationId).resolveScopeGroups(fieldDevicePolicyKey, scopes, asOf, { recordedAt: asOf });
      for (const [propertyId, policy] of resolved) devicePolicies.set(propertyId, policy);
    }
    const changedData = dataRows.filter(row => known.get(row.id) !== visibility(row).revision);
    const changedKnown = eligibleKnown.filter(row => known.get(row.id) !== visibility(row).revision);
    const ids = [...new Set([...changedData, ...changedKnown].map(row => row.id))];
    const records = ids.length ? await repo.snapshots(ctx.actorId, ctx.authContext, now, ids, input.mode) : [];
    const snapshots = new Map<string, FieldWorkSnapshot>();
    function snapshot(row: FieldPullSnapshotRecord): FieldWorkSnapshot {
      const view = visibility(row);
      const data = { id: row.id, propertyId: row.propertyId, propertyName: row.property.name,
        propertyAddress: [row.property.addressLine1, row.property.addressLine2, row.property.city].filter(Boolean).join(", "),
        propertyTimezone: row.property.timezone, reservationReference: row.reservation?.reference ?? null,
        guestName: row.reservation?.guestName ?? null, title: toStringRecord(row.titleTranslations), type: row.type, state: row.state,
        priority: row.priority, dueDate: row.dueDate.toISOString().slice(0, 10), businessDate: view.date,
        serverVersion: row.updatedAt.toISOString(), revision: view.revision, canEdit: view.canEdit,
        checklistItems: row.checklistItems.map(item => ({ id: item.id, key: item.key, label: toStringRecord(item.labelTranslations), completed: Boolean(item.completedAt) })),
        ...(input.include_device_policy ? { devicePolicy: view.devicePolicy } : {}),
        ...(input.include_linen ? { linen: view.linen } : {}),
        ...(input.include_inventory ? { inventory: view.inventory } : {}),
        ...(input.mode === "supervised" ? { proxyValidation: { performedByPersonId: row.assignedToPersonId!, expectedVersion: row.version,
          ...present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...view.task, data: { performerName: row.assignedToPerson!.displayName } },
            { performerName: { dataClass: "personal", mask: "omit", requiredPermission: view.canPerformer ? "team_member:view" : undefined } }, now) } } : {}) };
      return fieldWorkSnapshotSchema.parse(present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view",
        { ...view.task, data }, { guestName: { dataClass: "guest", mask: "omit", requiredPermission: view.canGuest ? "guest:view" : undefined } }, now));
    }
    for (const row of records) if (allowed(row)) snapshots.set(row.id, snapshot(row));
    const currentKnown = new Set(eligibleKnown.map(row => row.id)), changedKnownIds = new Set(changedKnown.map(row => row.id));
    const last = page.at(-1);
    const cursor = encodeFieldPullCursor({ ...frame, kind: hasMore ? "page" : "checkpoint",
      after: hasMore && last ? { date: last.dueDate.toISOString().slice(0, 10), id: last.id } : null }, ctx, deps.env);
    return { op_schema_version: 1, organization_id: ctx.organizationId, actor_user_id: ctx.actorId,
      snapshot_at: frame.asOf, cursor, next_cursor: hasMore ? cursor : null,
      tasks: changedData.flatMap(row => snapshots.has(row.id) ? [snapshots.get(row.id)!] : []),
      known_changes: changedKnown.flatMap(row => snapshots.has(row.id) ? [snapshots.get(row.id)!] : []),
      tombstones: input.known_tasks.filter(item => !currentKnown.has(item.id) || (changedKnownIds.has(item.id) && !snapshots.has(item.id))).map(item => item.id) };
  });
}
