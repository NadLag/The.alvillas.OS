import Dexie, { type Table } from "dexie";
import type { SyncPushOp, SyncPushOpResult } from "@/modules/reservations/domain/sync-protocol";

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
export const fieldIdentity = (scope: FieldQueueScope) => `${scope.organizationId}:${scope.userId}`;

export class FieldQueueStore extends Dexie {
  operations!: Table<FieldQueueEntry, number>;
  metadata!: Table<Metadata, string>;

  constructor(name = "alvillas.field.v1") {
    super(name);
    this.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
  }

  async activate(scope: FieldQueueScope): Promise<void> {
    await this.transaction("rw", this.operations, this.metadata, async () => {
      const current = await this.metadata.get("identity");
      if (current?.value !== fieldIdentity(scope)) {
        await this.operations.clear();
        await this.metadata.put({ key: "identity", value: fieldIdentity(scope) });
      }
      if (!await this.metadata.get("device")) {
        await this.metadata.put({ key: "device", value: crypto.randomUUID() });
      }
    });
  }

  async entries(scope: FieldQueueScope): Promise<FieldQueueEntry[]> {
    return this.operations.where("[organizationId+userId]").equals([scope.organizationId, scope.userId]).sortBy("sequence");
  }

  async store(scope: FieldQueueScope, operation: SyncPushOp, deviceId?: string): Promise<FieldQueueEntry> {
    const parsed = operation;
    return this.transaction("rw", this.operations, this.metadata, async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      const localId = `${fieldIdentity(scope)}:${parsed.client_op_id}`;
      const existing = await this.operations.where("localId").equals(localId).first();
      if (existing) return existing;
      const item: FieldQueueEntry = { ...scope, localId, deviceId: deviceId ?? (await this.metadata.get("device"))!.value,
        operation: parsed, syncStatus: "pending" };
      item.sequence = await this.operations.add(item);
      return item;
    });
  }

  async acknowledge(scope: FieldQueueScope, entry: FieldQueueEntry, result: SyncPushOpResult): Promise<boolean> {
    return this.transaction("rw", this.operations, this.metadata, async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return false;
      if (result.status === "APPLIED" || (result.status === "DUPLICATE" && (!result.error_code || result.error_code === "DUPLICATE_COMPLETION"))) {
        await this.operations.delete(entry.sequence!);
      } else {
        await this.operations.update(entry.sequence!, { syncStatus: result.status === "CONFLICT" ? "conflict" : "rejected", result });
      }
      return true;
    });
  }

  async wipe(scope?: FieldQueueScope): Promise<void> {
    await this.transaction("rw", this.operations, this.metadata, async () => {
      if (scope && (await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return;
      await this.operations.clear();
      await this.metadata.clear();
    });
  }

}
