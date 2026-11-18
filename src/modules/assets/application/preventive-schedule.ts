import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { assertAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { recurringTasksSchema } from "@/platform/config/operation-policy";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { assetPreventiveOptions, saveOperationSeries, type OperationDeps } from "@/platform/reservations/asset-preventive-operations";
import { AssetAccessError } from "../domain/asset";
import { assetPreventiveKey, preventiveScheduleSchema } from "../domain/preventive-schedule";
import { AssetLifecycleRepository } from "../infrastructure/asset-lifecycle-repository";
import { AssetRepository } from "../infrastructure/asset-repository";
import { readAssetSource } from "./asset-service";

export async function readAssetPreventiveSchedule(actor: AccountActorContext, assetId: string, db: TenantTransactionRunner = prisma) {
  return withTenant(db, actor.organizationId, async tx => {
    const source = await readAssetSource(actor, tx, assetId);
    const asset = source.checks[1].resource;
    const task = { ...asset, type: "task", id: undefined } as const;
    const current = await authContextForAccountInTransaction(tx, actor.organizationId, actor.actorId);
    const repo = new AssetRepository(tx, actor.organizationId);
    const now = await repo.clock();
    const allowed = (checks: CurrentAuthorityCheck[]) => {
      try { assertAccountAuthorization(actor, current, now, checks, new AssetAccessError()); return true; }
      catch (error) { if (error instanceof AssetAccessError) return false; throw error; }
    };
    if (!allowed([{ action: "view", resource: task }])) return null;
    const key = assetPreventiveKey(assetId);
    const active = await new AssetLifecycleRepository(tx, actor.organizationId).active(assetId, source.propertyId);
    const baseEdit = active && allowed([{ action: "edit", resource: asset }, { action: "create", resource: task }]);
    const { rule, checklists } = await assetPreventiveOptions(tx, actor.organizationId, source.propertyId, now, baseEdit);
    const schedule = rule ? recurringTasksSchema.parse(rule.parsedValue).series.find(series => series.key === key) : undefined;
    const canEdit = baseEdit && (!schedule || allowed([{ action: "edit", resource: task }]));
    const tasks = await repo.preventiveTasks(source.propertyId, key);
    return { version: rule?.version ?? 0, schedule: schedule && { ...schedule, enabled: active && schedule.enabled },
      canEdit, checklists: canEdit ? checklists : [],
      tasks: tasks.filter(row => allowed([{ action: "view", resource: { ...task, id: row.id, status: row.state,
        occurredAt: row.dueDate, assignedPersonId: row.assignedToPersonId, assignedUserAccountId: row.assignedToUserAccountId } }])) };
  });
}

export async function saveAssetPreventiveSchedule(actor: AccountActorContext, raw: unknown, deps: OperationDeps = {}) {
  const command = preventiveScheduleSchema.parse(raw);
  const personId = actor.authContext.personId;
  if (!personId) throw new AssetAccessError();
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const source = await readAssetSource(actor, tx, command.assetId);
    await saveOperationSeries({ ...actor, personId }, {
      propertyId: source.propertyId, expectedVersion: command.expectedVersion,
      definition: { ...command.definition, key: assetPreventiveKey(command.assetId), type: "MAINTENANCE" },
      reason: command.reason, cancelFuture: command.cancelFuture
    }, { ...deps, db: { $transaction: work => work(tx) } });
  });
}
