import { randomUUID } from "node:crypto";
import { calendarDateAt } from "@/i18n/format";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { assertAccountAuthorization, recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { maskedValue } from "@/platform/authz/present";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import { AssetAccessError, AssetConflictError } from "../domain/asset";
import { assetLifecycleSchema } from "../domain/asset-lifecycle";
import { AssetLifecycleRepository } from "../infrastructure/asset-lifecycle-repository";
import { AssetRepository } from "../infrastructure/asset-repository";
import { readAssetSource } from "./asset-service";

type Dependencies = { db?: TenantTransactionRunner; requestId?: string };
export async function readAssetLifecycle(actor: AccountActorContext, assetId: string, before?: number, deps: Dependencies = {}) {
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const source = await readAssetSource(actor, tx, assetId);
    const assets = new AssetRepository(tx, actor.organizationId);
    const row = await assets.find(assetId);
    if (!row) throw new AssetAccessError();
    const repo = new AssetLifecycleRepository(tx, actor.organizationId);
    const [rows, head, ctx, now] = await Promise.all([
      repo.history(assetId, before), before ? repo.history(assetId, undefined, 1).then(events => events[0]) : undefined,
      authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId), assets.clock()
    ]);
    const current = before ? head : rows[0];
    const resource = source.checks[1].resource;
    function allows(check: CurrentAuthorityCheck) {
      try { assertAccountAuthorization(actor, ctx, now, [check], new AssetAccessError()); return true; }
      catch (error) { if (error instanceof AssetAccessError) return false; throw error; }
    }
    const items = [];
    for (const event of rows.slice(0, 25)) {
      const visible = event.amount == null || allows({ action: "view", resource: { ...resource, type: "asset_cost", dataClass: "financial",
        financialRecordId: assetId, amount: event.amount, occurredAt: calendarDateStart(event.effectiveOn!, row.timezone) } });
      const successor = event.successorId ? await readAssetSource(actor, tx, event.successorId, source.propertyId)
        .catch((error: unknown) => { if (error instanceof AssetAccessError) return null; throw error; }) : null;
      items.push({ id: event.id, number: event.number, kind: event.kind, effectiveOn: event.effectiveOn,
        method: event.method, reference: event.reference, reason: visible ? event.reason : maskedValue,
        createdAt: event.createdAt, successor: successor ? { id: successor.id, label: successor.label, tag: successor.tag } : null,
        budget: !visible ? maskedValue : event.amount && event.currency ? Money.of(event.amount, event.currency).toJSON() : null });
    }
    await source.recheck();
    return { items, current: current?.kind, version: current?.number ?? 0, next: rows.length > 25 ? rows[24].number : undefined,
      canPlan: current?.kind !== "REPLACE" && current?.kind !== "DISPOSE" && allows({ action: "edit", resource }),
      canDispose: current?.kind !== "DISPOSE" && allows({ action: "void", resource }),
      canBudget: allows({ action: "edit", resource: { ...resource, type: "asset_cost", dataClass: "financial", financialRecordId: assetId } }) &&
        allows({ action: "view", resource: { ...resource, type: "asset_cost", dataClass: "financial", financialRecordId: assetId } }) };
  });
}

export async function recordAssetLifecycle(actor: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const command = assetLifecycleSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const assets = new AssetRepository(tx, actor.organizationId);
    const repo = new AssetLifecycleRepository(tx, actor.organizationId);
    const source = await readAssetSource(actor, tx, command.assetId);
    const successorId = command.kind === "REPLACE" ? await repo.successorId(source.propertyId, command.successorTag) : undefined;
    if (command.kind === "REPLACE" && (!successorId || successorId === command.assetId)) throw new AssetConflictError();
    await assets.lock("lifecycle-command:" + actor.actorId + ":" + command.idempotencyKey);
    await repo.lock(successorId ? [command.assetId, successorId] : [command.assetId]);
    const row = await assets.find(command.assetId);
    if (!row) throw new AssetAccessError();
    const resource = source.checks[1].resource;
    const checks: CurrentAuthorityCheck[] = [...source.checks, { action: command.kind === "DISPOSE" ? "void" : "edit", resource }];
    const successor = successorId ? await readAssetSource(actor, tx, successorId, source.propertyId) : null;
    const now = await assets.clock();
    let budget: { amount: string; currency: string } | null = null;
    if (command.kind === "PLAN" && command.budget) {
      const currency = await assets.currency(command.budget.currency);
      if (!currency || currency.minorUnit > 2) throw new AssetConflictError();
      const amount = Money.of(command.budget.amount, command.budget.currency);
      if (amount.amount.decimalPlaces() > currency.minorUnit) throw new AssetConflictError();
      budget = amount.toJSON();
      const cost = { ...resource, type: "asset_cost", dataClass: "financial" as const, financialRecordId: command.assetId,
        amount: budget.amount, occurredAt: calendarDateStart(command.effectiveOn, row.timezone) };
      checks.push({ action: "view", resource: cost }, { action: "edit", resource: cost });
    }
    await recheckAccountAuthorization(actor, tx, now, checks, new AssetAccessError());
    const requestHash = jsonbFingerprint(command);
    const prior = await repo.receipt(actor.actorId, command.idempotencyKey);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new AssetConflictError();
      return { version: prior.number };
    }
    const [head] = await repo.history(command.assetId, undefined, 1);
    if ((head?.number ?? 0) !== command.expectedVersion || head?.kind === "DISPOSE" ||
      (head?.kind === "REPLACE" && (command.kind !== "DISPOSE" || command.effectiveOn < head.effectiveOn!)) ||
      (command.kind === "CANCEL" && head?.kind !== "PLAN")) throw new AssetConflictError();
    if ((command.kind === "REPLACE" || command.kind === "DISPOSE") &&
      (command.effectiveOn > calendarDateAt(now, row.timezone) || (row.purchaseOn && command.effectiveOn < row.purchaseOn)))
      throw new AssetConflictError();
    if (command.kind === "PLAN" && head?.kind === "PLAN" && head.amount !== null && head.effectiveOn) {
      const originalBudget = { ...resource, type: "asset_cost", dataClass: "financial" as const, financialRecordId: command.assetId,
        amount: head.amount, occurredAt: calendarDateStart(head.effectiveOn, row.timezone) };
      checks.push({ action: "view", resource: originalBudget }, { action: "edit", resource: originalBudget });
      await recheckAccountAuthorization(actor, tx, now, checks, new AssetAccessError());
    }
    if (successorId && (!await repo.active(successorId, source.propertyId) || await repo.hasPredecessor(successorId)))
      throw new AssetConflictError();
    const eventId = await repo.append(command, { actorId: actor.actorId, requestHash, successorId, budget, now });
    await writeAuditEvent(tx, { organizationId: actor.organizationId, actorId: actor.actorId, propertyScopeId: row.propertyId,
      resourceType: "asset", resourceId: row.id, action: "asset.lifecycle_recorded", after: { eventId, kind: command.kind, number: command.expectedVersion + 1 },
      requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    await source.recheck();
    await successor?.recheck();
    await recheckAccountAuthorization(actor, tx, await assets.clock(), checks, new AssetAccessError());
    return { version: command.expectedVersion + 1 };
  });
}
