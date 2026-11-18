import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { assertAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { recurringTasksSchema } from "@/platform/config/operation-policy";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { OperationDeps } from "@/modules/reservations/application/operation-service";
import { saveOperationSeries } from "@/modules/reservations/application/operation-automation";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { AssetAccessError } from "../domain/asset";
import { assetPreventiveKey, preventiveScheduleSchema } from "../domain/preventive-schedule";
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
    const operations = new OperationRepository(tx, actor.organizationId);
    const key = assetPreventiveKey(assetId);
    const rule = await operations.recurring(source.propertyId, now);
    const schedule = rule ? recurringTasksSchema.parse(rule.parsedValue).series.find(series => series.key === key) : undefined;
    const canEdit = allowed([
      { action: "edit", resource: asset }, { action: "create", resource: task },
      ...(schedule ? [{ action: "edit", resource: task } as const] : [])
    ]);
    const [tasks, catalog] = await Promise.all([
      repo.preventiveTasks(source.propertyId, key),
      canEdit ? operations.checklists(source.propertyId) : null
    ]);
    return { version: rule?.version ?? 0, schedule, canEdit, checklists: catalog?.catalog.checklists.map(({ key, name }) => ({ key, name })) ?? [],
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
