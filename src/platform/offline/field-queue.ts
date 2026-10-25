import { syncPushOpSchema, type SyncPushOp } from "@/modules/reservations/domain/sync-protocol";
import { FieldQueueStore, type FieldQueueScope, type FieldQueueEntry, type FieldProxyDraftInput, type FieldLinenDraftInput } from "./field-queue-store";
import { requestFieldBackgroundSync } from "./background-sync";
import { fieldUploadManifestSchema } from "@/modules/reservations/domain/field-upload";
import type { FieldIssueOperation } from "./field-queue-store";
export type { FieldQueueScope, FieldQueueEntry, QueueOutcome } from "./field-queue-store";
export { syncFieldQueue } from "./field-sync";

const legacyQueueKey = "alvillas.fieldTaskQueue.v1";
const legacyDeviceKey = "alvillas.fieldDeviceId.v1";
export class FieldQueue extends FieldQueueStore {
  async enqueueIssue(scope: FieldQueueScope, operation: FieldIssueOperation, incarnation: string,
    photo?: { manifest: unknown; blob: Blob }): Promise<FieldQueueEntry> {
    const parsed = syncPushOpSchema.parse(operation);
    if (parsed.type !== "field_task.issue.report") throw new Error("FIELD_ISSUE_INVALID");
    const entry = await this.storeIssue(scope, parsed, incarnation, photo ? { manifest: fieldUploadManifestSchema.parse(photo.manifest), blob: photo.blob } : undefined);
    void requestFieldBackgroundSync(); return entry;
  }
  async enqueueLinen(scope: FieldQueueScope, value: FieldLinenDraftInput, incarnation: string): Promise<FieldQueueEntry> {
    const payload = { taskId: value.taskId, itemKey: value.itemKey, expectedQuantity: value.expectedQuantity, expectedRevision: value.expectedRevision,
      countedQuantity: value.countedQuantity, unit: value.unit, catalogRuleId: value.catalogRuleId, catalogVersion: value.catalogVersion, note: value.note };
    const operation = syncPushOpSchema.parse({ client_op_id: value.clientOpId, type: "field_stocktake.record", client_created_at: new Date().toISOString(), payload });
    if (operation.type !== "field_stocktake.record") throw new Error("FIELD_LINEN_INVALID");
    const entry = await this.storeLinenOperation(scope, operation, incarnation);
    if (entry.syncStatus === "pending") void requestFieldBackgroundSync();
    return entry;
  }
  async enqueueProxy(scope: FieldQueueScope, value: FieldProxyDraftInput, incarnation: string): Promise<FieldQueueEntry> {
    const operation = syncPushOpSchema.parse({ client_op_id: value.clientOpId, type: "field_task.proxy_validate", client_created_at: new Date().toISOString(),
      payload: { taskId: value.taskId, expectedVersion: value.expectedVersion, performedByPersonId: value.performedByPersonId,
        checklistItemIds: value.checklistItemIds, reason: value.reason } });
    if (operation.type !== "field_task.proxy_validate") throw new Error("FIELD_PROXY_INVALID");
    const entry = await this.storeProxyOperation(scope, operation, incarnation);
    if (entry.syncStatus === "pending") void requestFieldBackgroundSync();
    return entry;
  }

  async enqueuePhoto(scope: FieldQueueScope, manifest: unknown, blob: Blob, incarnation: string): Promise<FieldQueueEntry> {
    const stored = await this.storePhoto(scope, fieldUploadManifestSchema.parse(manifest), blob, incarnation);
    void requestFieldBackgroundSync(); return stored;
  }
  async enqueue(scope: FieldQueueScope, operation: SyncPushOp, deviceId?: string): Promise<FieldQueueEntry> {
    const stored = await this.store(scope, syncPushOpSchema.parse(operation), deviceId);
    void requestFieldBackgroundSync();
    return stored;
  }

  async migrateLegacy(scope: FieldQueueScope, storage: Pick<Storage, "getItem" | "removeItem">): Promise<void> {
    const raw = storage.getItem(legacyQueueKey);
    if (!raw) return;
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) throw new Error("FIELD_LEGACY_QUEUE_INVALID");
    // The global account UUID identifies the tenant of a legacy record.
    // Commit each validated record before deleting the old queue; retries reuse its key.
    for (const value of values) {
      if (!value || typeof value !== "object") throw new Error("FIELD_LEGACY_QUEUE_INVALID");
      const item = value as Record<string, unknown>;
      if (item.userId !== scope.userId) continue;
      if (item.schemaVersion !== 1 || item.operation !== "field_task.complete" || typeof item.deviceId !== "string") throw new Error("FIELD_LEGACY_QUEUE_INVALID");
      const op = syncPushOpSchema.parse({ client_op_id: item.clientOpId, type: item.operation,
        client_created_at: item.clientCreatedAt, payload: { taskId: item.taskId, checklistItemIds: item.checklistItemIds, note: item.note } });
      const queued = await this.enqueue(scope, op, item.deviceId);
      if (item.syncStatus === "conflict" || item.syncStatus === "rejected") {
        await this.acknowledge(scope, queued, { client_op_id: op.client_op_id, status: item.syncStatus === "conflict" ? "CONFLICT" : "REJECTED", server_version: null });
      }
    }
    storage.removeItem(legacyQueueKey);
    storage.removeItem(legacyDeviceKey);
  }
}

let instance: FieldQueue | undefined;
export function fieldQueue(): FieldQueue { return instance ??= new FieldQueue(); }

export async function wipeFieldData(): Promise<void> {
  await fieldQueue().wipe();
  localStorage.removeItem(legacyQueueKey);
  localStorage.removeItem(legacyDeviceKey);
}
