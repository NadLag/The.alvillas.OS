import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { jsonbFingerprint } from "@/platform/http/command-fingerprint";
import { maintenanceAuthorityStamp } from "@/platform/maintenance/issue-sources";
import { workOrderAssetSource } from "@/platform/maintenance/work-order-asset-source";
import { changeWorkOrderAssetSchema, workOrderAssetViewSchema } from "../domain/work-order-asset";
import { WorkOrderAccessError, WorkOrderConflictError } from "../domain/work-order";
import { WorkOrderRepository } from "../infrastructure/work-order-repository";
import { WorkOrderAssetRepository } from "../infrastructure/work-order-asset-repository";
import { findRegisteredWorkOrder, workOrderActor } from "./work-order-access";

type Dependencies = { db?: TenantTransactionRunner; requestId?: string };
const readSchema = z.object({ taskId: z.uuid(), before: z.number().int().positive().optional() }).strict();

export async function readWorkOrderAssets(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = workOrderActor(context), input = readSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const order = await findRegisteredWorkOrder(actor, tx, input.taskId);
    const repo = new WorkOrderAssetRepository(tx, actor.organizationId);
    const rows = await repo.list(input.taskId, 26, input.before);
    const head = input.before ? (await repo.list(input.taskId, 1))[0] : rows[0];
    let canEdit = false;
    try { await findRegisteredWorkOrder(actor, tx, input.taskId, "edit"); canEdit = true; }
    catch (error) { if (!(error instanceof WorkOrderAccessError)) throw error; }
    const show = async (row: (typeof rows)[number]) => {
      const at = row.at.toISOString();
      if (!row.assetId) return { state: "CLEARED" as const, number: row.number, at };
      try {
        const source = await workOrderAssetSource(actor, tx, row.assetId, order.task.task.propertyId);
        return { state: "LINKED" as const, number: row.number, at, assetId: source.id,
          label: source.label, tag: source.tag, reason: row.reason };
      } catch (error) {
        if (error instanceof WorkOrderAccessError) return { state: "MASKED" as const };
        throw error;
      }
    };
    const items = [];
    for (const row of rows.slice(0, 25)) items.push(await show(row));
    const current = head ? (input.before ? await show(head) : items[0]) : null;
    await order.recheck();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return workOrderAssetViewSchema.parse({ authorizationStamp: stamp, number: head?.number ?? 0, canEdit, current, items,
      next: rows.length > 25 ? rows[24].number : null });
  });
}

export async function changeWorkOrderAsset(context: AccountActorContext, raw: unknown, deps: Dependencies = {}) {
  const actor = workOrderActor(context), input = changeWorkOrderAssetSchema.parse(raw);
  return withTenant(deps.db ?? prisma, actor.organizationId, async tx => {
    const stamp = await maintenanceAuthorityStamp(actor, tx);
    const orders = new WorkOrderRepository(tx, actor.organizationId), repo = new WorkOrderAssetRepository(tx, actor.organizationId);
    await orders.lockActor(actor.actorId, input.idempotencyKey);
    const prior = await repo.receipt(actor.actorId, input.idempotencyKey), requestHash = jsonbFingerprint(input);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new WorkOrderConflictError();
      return { recorded: true as const };
    }
    await orders.lockTask(input.taskId);
    const order = await findRegisteredWorkOrder(actor, tx, input.taskId, "edit");
    const [head] = await repo.list(input.taskId, 1);
    if ((head?.number ?? 0) !== input.expectedRevision || (head?.assetId ?? null) === input.assetId) throw new WorkOrderConflictError();
    const source = input.assetId ? await workOrderAssetSource(actor, tx, input.assetId, order.task.task.propertyId) : null;
    const previous = head?.assetId ? await workOrderAssetSource(actor, tx, head.assetId, order.task.task.propertyId) : null;
    const at = await orders.clock(), number = input.expectedRevision + 1;
    const record = await repo.append({ ...input, assetRevisionId: source?.revisionId ?? null, actorId: actor.actorId, number, requestHash, at });
    await writeAuditEvent(tx, {
      organizationId: actor.organizationId, actorId: actor.actorId, action: "maintenance.work_order.asset_changed",
      resourceType: "maintenance_work_order", resourceId: input.taskId, propertyScopeId: order.task.task.propertyId,
      after: { recordId: record.id, number, linked: Boolean(source) }, requestId: deps.requestId ?? randomUUID(), occurredAt: at
    });
    await previous?.recheck();
    await source?.recheck();
    await order.recheck();
    if (stamp !== await maintenanceAuthorityStamp(actor, tx)) throw new WorkOrderConflictError();
    return { recorded: true as const };
  });
}
