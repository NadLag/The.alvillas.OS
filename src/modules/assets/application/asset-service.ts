import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import type { AuthContext, Resource } from "@/platform/authz/authorize";
import { assertAccountAuthorization, recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { present, maskedValue } from "@/platform/authz/present";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import { AssetAccessError, AssetConflictError, assetSearchSchema, createAssetSchema, reviseAssetSchema, type AssetFields } from "../domain/asset";
import { AssetRepository, type AssetProperty, type AssetHead } from "../infrastructure/asset-repository";

type Dependencies = { db?: TenantTransactionRunner; requestId?: string };
const pageInput = z.object({ assetId: z.uuid(), before: z.number().int().positive().optional() }).strict();
const propertyInput = z.object({ query: z.string().trim().max(120).default(""), cursor: z.uuid().optional() }).strict();
type Cost = NonNullable<AssetFields["cost"]>;

function resource(actor: AccountActorContext, property: AssetProperty, id?: string): Resource {
  return { type: "asset", organizationId: actor.organizationId, id, propertyId: property.propertyId,
    region: property.regionId, city: property.cityId, dataClass: "operational" };
}

function assetChecks(actor: AccountActorContext, property: AssetProperty, action: "view" | "create" | "edit" = "view", id?: string): CurrentAuthorityCheck[] {
  const asset = resource(actor, property, id);
  return [{ action: "view", resource: { ...asset, type: "property", id: property.propertyId } },
    { action: "view", resource: asset }, { action, resource: asset }];
}

function costResource(actor: AccountActorContext, property: AssetProperty, id?: string, cost?: Cost | null, purchaseOn?: string | null): Resource {
  return { ...resource(actor, property, id), type: "asset_cost", dataClass: "financial", financialRecordId: id,
    amount: cost?.amount, occurredAt: purchaseOn ? calendarDateStart(purchaseOn, property.timezone) : undefined };
}

function allows(actor: AccountActorContext, current: AuthContext, now: Date, checks: CurrentAuthorityCheck[]) {
  try {
    assertAccountAuthorization(actor, current, now, checks, new AssetAccessError());
    return true;
  } catch (error) { if (error instanceof AssetAccessError) return false; throw error; }
}

function originalCost(row?: AssetHead): Cost | null {
  return row?.purchaseAmount != null && row.currency ? Money.of(row.purchaseAmount, row.currency).toJSON() : null;
}

function presentHead(actor: AccountActorContext, current: AuthContext, row: AssetHead, now: Date) {
  const cost = originalCost(row), financial = costResource(actor, row, row.id, cost, row.purchaseOn);
  const canViewCost = allows(actor, current, now, [{ action: "view", resource: financial }]);
  const fields = { id: row.id, tag: row.tag, propertyId: row.propertyId, propertyName: row.propertyName, number: row.number,
    name: row.name, category: row.category, description: row.description, condition: row.condition, purchaseOn: row.purchaseOn,
    warrantyProvider: row.warrantyProvider, warrantyReference: row.warrantyReference, warrantyStartsOn: row.warrantyStartsOn,
    warrantyEndsOn: row.warrantyEndsOn, retirement: row.retirement ?? null, usefulLifeMonths: row.usefulLifeMonths, updatedAt: row.createdAt.toISOString(),
    cost: canViewCost ? cost : maskedValue };
  const operational = present({ ...actor.authContext, visibleDataClasses: new Set(["operational"]) }, "view",
    { ...resource(actor, row, row.id), data: fields }, {}, now) as typeof fields;
  return { ...operational, canEdit: allows(actor, current, now, assetChecks(actor, row, "edit", row.id)),
    canEditCost: canViewCost && allows(actor, current, now, [{ action: "edit", resource: financial }]) };
}

export async function readAssetSource(actor: AccountActorContext, tx: TenantTransaction, id: string, propertyId?: string) {
  const repository = new AssetRepository(tx, actor.organizationId);
  const row = await repository.find(id);
  if (!row || propertyId && row.propertyId !== propertyId) throw new AssetAccessError();
  const checks = assetChecks(actor, row, "view", row.id);
  const now = await repository.clock();
  await recheckAccountAuthorization(actor, tx, now, checks, new AssetAccessError());
  const fields = { id: row.id, propertyId: row.propertyId, label: row.name, tag: row.tag, revisionId: row.revisionId };
  return { ...fields, checks, recheck: async () => {
    const fresh = await repository.find(id);
    if (!fresh || fresh.revisionId !== row.revisionId) throw new AssetConflictError();
    await recheckAccountAuthorization(actor, tx, await repository.clock(), checks, new AssetAccessError());
  } };
}

export async function listAssets(actor: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const query = assetSearchSchema.extend({ cursor: z.uuid().optional() }).parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new AssetRepository(tx, actor.organizationId), now = await repository.clock();
    const rows = await repository.search(query.query, query.propertyId, query.cursor);
    const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    return { items: rows.slice(0, 40).filter(row => allows(actor, current, now, assetChecks(actor, row, "view", row.id)))
      .map(row => presentHead(actor, current, row, now)), next: rows.length > 40 ? rows[39].id : undefined };
  });
}

export async function listAssetProperties(actor: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const input = propertyInput.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new AssetRepository(tx, actor.organizationId), now = await repository.clock();
    const rows = await repository.properties(input.query, input.cursor);
    const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    return { items: rows.slice(0, 40).filter(row => allows(actor, current, now, assetChecks(actor, row, "create")))
      .map(row => {
        const financial = costResource(actor, row);
        return { id: row.propertyId, label: row.propertyName,
          canEnterCost: allows(actor, current, now, [{ action: "view", resource: financial }, { action: "edit", resource: financial }]) };
      }), next: rows.length > 40 ? rows[39].propertyId : undefined };
  });
}

export async function getAsset(actor: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const input = pageInput.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new AssetRepository(tx, actor.organizationId), row = await repository.find(input.assetId);
    if (!row) throw new AssetAccessError();
    const rows = await repository.history(row.id, input.before), now = await repository.clock();
    const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    assertAccountAuthorization(actor, current, now, assetChecks(actor, row, "view", row.id), new AssetAccessError());
    return { asset: presentHead(actor, current, row, now),
      history: rows.slice(0, 25).map(revision => {
        const view = presentHead(actor, current, revision, now);
        return { ...view, reason: view.cost === maskedValue ? maskedValue : revision.reason };
      }),
      next: rows.length > 25 ? rows[24].number : undefined };
  });
}

export async function saveAsset(actor: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const input = z.union([createAssetSchema, reviseAssetSchema]).parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const repository = new AssetRepository(tx, actor.organizationId);
    await repository.lock("nonce:" + actor.actorId + ":" + input.idempotencyKey);
    if ("assetId" in input) await repository.lock(input.assetId);
    const requestHash = jsonbFingerprint(input), prior = await repository.receipt(actor.actorId, input.idempotencyKey);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AssetConflictError();
      await readAssetSource(actor, tx, prior.assetId);
      return { id: prior.assetId, number: prior.number };
    }
    const before = "assetId" in input ? await repository.find(input.assetId) : undefined;
    const property = "propertyId" in input ? await repository.property(input.propertyId) : before;
    if (!property) throw new AssetAccessError();
    if ("expectedRevision" in input && before?.number !== input.expectedRevision) throw new AssetConflictError();
    const now = await repository.clock();
    const checks = assetChecks(actor, property, before ? "edit" : "create", before?.id);
    const oldCost = originalCost(before);
    const suppliedCost = input.fields.cost === undefined ? oldCost : input.fields.cost;
    const cost = suppliedCost ? Money.of(suppliedCost.amount, suppliedCost.currency).toJSON() : null;
    if (cost && !input.fields.purchaseOn) throw new AssetConflictError();
    if (jsonbFingerprint(oldCost) !== jsonbFingerprint(cost) || oldCost && before?.purchaseOn !== input.fields.purchaseOn) {
      const earlier = costResource(actor, property, before?.id, oldCost, before?.purchaseOn);
      const planned = costResource(actor, property, before?.id, cost, input.fields.purchaseOn);
      checks.push({ action: "view", resource: planned }, { action: "edit", resource: planned });
      if (oldCost) checks.push({ action: "view", resource: earlier }, { action: "edit", resource: earlier });
    }
    await recheckAccountAuthorization(actor, tx, now, checks, new AssetAccessError());
    if (cost) {
      const currency = await repository.currency(cost.currency);
      if (!currency || currency.minorUnit > 2 || Money.of(cost.amount, cost.currency).amount.decimalPlaces() > currency.minorUnit)
        throw new AssetConflictError();
    }
    const asset = "tag" in input ? await repository.create(property.propertyId, input.tag) : before;
    if (!asset) throw new AssetConflictError();
    const number = (before?.number ?? 0) + 1;
    const revision = await repository.append({ ...input, assetId: asset.id, number, actorId: actor.actorId,
      fields: { ...input.fields, cost }, now, requestHash });
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.actorId, action: "asset.revised",
      resourceType: "asset", resourceId: asset.id, propertyScopeId: property.propertyId,
      after: { revisionId: revision.id, number }, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await recheckAccountAuthorization(actor, tx, await repository.clock(), checks, new AssetAccessError());
    return { id: asset.id, number };
  });
}
