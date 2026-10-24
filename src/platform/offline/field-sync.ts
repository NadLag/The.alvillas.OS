import type { SyncPushOpResult } from "@/modules/reservations/domain/sync-protocol";
import { fieldIdentity, type FieldQueueStore, type FieldQueueScope, type QueueOutcome } from "./field-queue-store";
import { prepareQueuedPhoto } from "./field-photo-sync";

const active = new WeakMap<FieldQueueStore, Map<string, Promise<QueueOutcome>>>();
export type FieldAcknowledgement = FieldQueueScope & { taskId: string; clientOpId: string };
type Acknowledge = (value: FieldAcknowledgement) => Promise<void>;
export function syncFieldQueue(queue: FieldQueueStore, scope: FieldQueueScope, send: typeof fetch = fetch, acknowledge?: Acknowledge): Promise<QueueOutcome> {
  const key = fieldIdentity(scope);
  let pending = active.get(queue);
  if (!pending) { pending = new Map(); active.set(queue, pending); }
  const existing = pending.get(key);
  if (existing) return existing;
  const result = drain(queue, scope, send, acknowledge).finally(() => pending.delete(key));
  pending.set(key, result);
  return result;
}

async function drain(queue: FieldQueueStore, scope: FieldQueueScope, send: typeof fetch, acknowledge?: Acknowledge): Promise<QueueOutcome> {
  const entries = await queue.entries(scope);
  let outcome: QueueOutcome = "idle";
  const blockedPhotoTasks = new Map<string, "conflict" | "rejected">();
  for (let entry of entries) {
    const photo = entry.operation.type === "field_photo.prepare" || entry.operation.type === "field_task.evidence.attach";
    if (entry.syncStatus !== "pending") {
      outcome = entry.syncStatus;
      if (photo) blockedPhotoTasks.set(entry.operation.payload.taskId, entry.syncStatus);
      continue;
    }
    if (entry.operation.type === "field_task.complete" && blockedPhotoTasks.has(entry.operation.payload.taskId)) {
      outcome = blockedPhotoTasks.get(entry.operation.payload.taskId)!; continue;
    }
    if (entry.operation.type === "field_photo.prepare" || entry.operation.type === "field_task.evidence.attach") {
      const prepared = await prepareQueuedPhoto(queue, scope, entry, send);
      if (prepared === "queued" || prepared === "rejected") return prepared;
      if (!prepared) continue;
      entry = prepared;
      if (entry.operation.type === "field_photo.prepare") return "queued";
    }
    if ((await queue.metadata.get("identity"))?.value !== fieldIdentity(scope)) return "rejected";
    let response: Response;
    try {
      response = await send("/api/sync/push", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: entry.deviceId,
          organization_id: scope.organizationId, actor_user_id: scope.userId, op_schema_version: 1, ops: [entry.operation] }) });
    } catch { return "queued"; }
    if (response.status === 401) { await queue.wipe(scope); return "rejected"; }
    if (!response.ok) return "queued";
    let payload: unknown;
    try { payload = await response.json(); } catch { return "queued"; }
    const result = parseAcknowledgement(payload, entry.operation.client_op_id);
    if (!result) return "queued";
    if (result.error_code === "REJECTED_SESSION_CHANGED") { await queue.wipe(scope); return "rejected"; }
    const saved = await queue.acknowledge(scope, entry, result);
    if (!saved) return "rejected";
    const applied = result.status === "APPLIED" || (result.status === "DUPLICATE" && (!result.error_code || result.error_code === "DUPLICATE_COMPLETION"));
    if (saved && applied && entry.operation.type === "field_task.complete") {
      const detail = { ...scope, taskId: entry.operation.payload.taskId, clientOpId: entry.operation.client_op_id };
      await acknowledge?.(detail);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("alvillas-field-acknowledged", { detail }));
    }
    outcome = applied
      ? outcome === "conflict" || outcome === "rejected" ? outcome : "synced"
      : result.status === "CONFLICT" ? "conflict" : "rejected";
    if (!applied && photo) blockedPhotoTasks.set(entry.operation.payload.taskId, result.status === "CONFLICT" ? "conflict" : "rejected");
  }
  return outcome;
}

function parseAcknowledgement(payload: unknown, id: string): SyncPushOpResult | null {
  if (!payload || typeof payload !== "object" || !("op_schema_version" in payload) || payload.op_schema_version !== 1 || !("results" in payload) || !Array.isArray(payload.results)) return null;
  const item = payload.results.find((r: unknown) => r && typeof r === "object" && "client_op_id" in r && r.client_op_id === id) as Partial<SyncPushOpResult> | undefined;
  if (!item || !["APPLIED", "DUPLICATE", "CONFLICT", "REJECTED"].includes(item.status ?? "") ||
    (item.server_version !== null && typeof item.server_version !== "string") ||
    (item.error_code !== undefined && typeof item.error_code !== "string")) return null;
  return item as SyncPushOpResult;
}
