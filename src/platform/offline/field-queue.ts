import Dexie, { type Table } from "dexie";
import { syncPushOpSchema, type SyncPushOp, type SyncPushOpResult } from "@/modules/reservations/domain/sync-protocol";

export type FieldQueueScope = { organizationId: string; userId: string };
export type FieldQueueEntry = FieldQueueScope & {
  localId: string;
  deviceId: string;
  sequence?: number;
  operation: SyncPushOp;
  syncStatus: "pending" | "conflict" | "rejected";
  result?: SyncPushOpResult;
};
type Metadata = { key: string; value: string };
export type QueueOutcome = "idle" | "synced" | "conflict" | "rejected" | "queued";
const legacyQueueKey = "alvillas.fieldTaskQueue.v1";
const legacyDeviceKey = "alvillas.fieldDeviceId.v1";
const identity = (scope: FieldQueueScope) => `${scope.organizationId}:${scope.userId}`;

export class FieldQueue extends Dexie {
  operations!: Table<FieldQueueEntry, number>;
  metadata!: Table<Metadata, string>;

  constructor(name = "alvillas.field.v1") {
    super(name);
    this.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
  }

  async activate(scope: FieldQueueScope): Promise<void> {
    await this.transaction("rw", this.operations, this.metadata, async () => {
      const current = await this.metadata.get("identity");
      if (current?.value !== identity(scope)) {
        await this.operations.clear();
        await this.metadata.put({ key: "identity", value: identity(scope) });
      }
      if (!await this.metadata.get("device")) {
        await this.metadata.put({ key: "device", value: crypto.randomUUID() });
      }
    });
  }

  async entries(scope: FieldQueueScope): Promise<FieldQueueEntry[]> {
    return this.operations.where("[organizationId+userId]").equals([scope.organizationId, scope.userId]).sortBy("sequence");
  }

  async enqueue(scope: FieldQueueScope, operation: SyncPushOp, deviceId?: string): Promise<FieldQueueEntry> {
    const parsed = syncPushOpSchema.parse(operation);
    return this.transaction("rw", this.operations, this.metadata, async () => {
      if ((await this.metadata.get("identity"))?.value !== identity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      const localId = `${identity(scope)}:${parsed.client_op_id}`;
      const existing = await this.operations.where("localId").equals(localId).first();
      if (existing) return existing;
      const item: FieldQueueEntry = { ...scope, localId, deviceId: deviceId ?? (await this.metadata.get("device"))!.value,
        operation: parsed, syncStatus: "pending" };
      item.sequence = await this.operations.add(item);
      return item;
    });
  }

  async acknowledge(scope: FieldQueueScope, entry: FieldQueueEntry, result: SyncPushOpResult): Promise<void> {
    await this.transaction("rw", this.operations, this.metadata, async () => {
      if ((await this.metadata.get("identity"))?.value !== identity(scope)) return;
      if (result.status === "APPLIED" || (result.status === "DUPLICATE" && (!result.error_code || result.error_code === "DUPLICATE_COMPLETION"))) {
        await this.operations.delete(entry.sequence!);
      } else {
        await this.operations.update(entry.sequence!, { syncStatus: result.status === "CONFLICT" ? "conflict" : "rejected", result });
      }
    });
  }

  async wipe(scope?: FieldQueueScope): Promise<void> {
    await this.transaction("rw", this.operations, this.metadata, async () => {
      if (scope && (await this.metadata.get("identity"))?.value !== identity(scope)) return;
      await this.operations.clear();
      await this.metadata.clear();
    });
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

export async function syncFieldQueue(queue: FieldQueue, scope: FieldQueueScope, send: typeof fetch = fetch): Promise<QueueOutcome> {
  const entries = await queue.entries(scope);
  let outcome: QueueOutcome = "idle";
  for (const entry of entries) {
    if (entry.syncStatus !== "pending") { outcome = entry.syncStatus; continue; }
    if ((await queue.metadata.get("identity"))?.value !== identity(scope)) return "rejected";
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
    await queue.acknowledge(scope, entry, result);
    outcome = result.status === "APPLIED" || (result.status === "DUPLICATE" && (!result.error_code || result.error_code === "DUPLICATE_COMPLETION"))
      ? outcome === "conflict" || outcome === "rejected" ? outcome : "synced"
      : result.status === "CONFLICT" ? "conflict" : "rejected";
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

export async function wipeFieldData(): Promise<void> {
  await fieldQueue().wipe();
  localStorage.removeItem(legacyQueueKey);
  localStorage.removeItem(legacyDeviceKey);
}
