import Dexie, { type Table } from "dexie";
import type { SyncPushOp, SyncPushOpResult } from "@/modules/reservations/domain/sync-protocol";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import type { FieldUploadManifest } from "@/modules/reservations/domain/field-upload";

export type FieldQueueScope = { organizationId: string; userId: string };
type PendingPhotoOperation = { client_op_id: string; type: "field_photo.prepare"; client_created_at: string;
  payload: { taskId: string; photoLocalId: string } };
export type FieldQueueEntry = FieldQueueScope & {
  localId: string;
  deviceId: string;
  sequence?: number;
  operation: SyncPushOp | PendingPhotoOperation;
  syncStatus: "pending" | "conflict" | "rejected";
  result?: SyncPushOpResult;
};
type Metadata = { key: string; value: string };
export type FieldCachedJob = FieldQueueScope & { cacheId: string; task: FieldWorkSnapshot };
export type FieldDraft = FieldQueueScope & { cacheId: string; taskId: string; checklistItemIds: string[]; note: string; savedAt: string };
export type FieldCacheRevision = { incarnation: string; generation: number };
export type FieldCacheState = FieldQueueScope & FieldCacheRevision & { key: string; snapshotAt?: string; cursor?: string; invalidated?: boolean };
export type FieldPhoto = FieldQueueScope & { cacheId: string; taskId: string; manifest: FieldUploadManifest; blob: Blob; deviceId: string;
  incarnation: string; uploadId?: string; uploadedParts: number[]; ready: boolean; attempts: number; retryAt: number };
export type QueueOutcome = "idle" | "synced" | "conflict" | "rejected" | "queued";
export const fieldIdentity = (scope: FieldQueueScope) => `${scope.organizationId}:${scope.userId}`;

export class FieldQueueStore extends Dexie {
  operations!: Table<FieldQueueEntry, number>;
  metadata!: Table<Metadata, string>;
  jobs!: Table<FieldCachedJob, string>;
  drafts!: Table<FieldDraft, string>;
  cacheState!: Table<FieldCacheState, string>;
  photos!: Table<FieldPhoto, string>;

  constructor(name = "alvillas.field.v1") {
    super(name);
    this.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
    this.version(2).stores({ jobs: "&cacheId,[organizationId+userId]", drafts: "&cacheId,[organizationId+userId]", cacheState: "key" });
    this.version(3).stores({ photos: "&cacheId,[organizationId+userId],taskId" });
  }

  async activate(scope: FieldQueueScope): Promise<void> {
    await this.activateWhenCurrent(scope);
  }

  async activateIfCurrent(scope: FieldQueueScope, expectedIdentity: string | null): Promise<boolean> {
    return this.activateWhenCurrent(scope, expectedIdentity);
  }

  private async activateWhenCurrent(scope: FieldQueueScope, expectedIdentity?: string | null): Promise<boolean> {
    return this.transaction("rw", [this.operations, this.metadata, this.jobs, this.drafts, this.cacheState, this.photos], async () => {
      const current = await this.metadata.get("identity");
      if (expectedIdentity !== undefined && (current?.value ?? null) !== expectedIdentity && current?.value !== fieldIdentity(scope)) return false;
      if (current?.value !== fieldIdentity(scope)) {
        await this.operations.clear();
        await this.jobs.clear(); await this.drafts.clear(); await this.cacheState.clear();
        await this.photos.clear();
        await this.metadata.put({ key: "identity", value: fieldIdentity(scope) });
      }
      if (!await this.metadata.get("device")) {
        await this.metadata.put({ key: "device", value: crypto.randomUUID() });
      }
      const key = fieldIdentity(scope);
      if (!await this.cacheState.get(key)) await this.cacheState.put({ ...scope, key, incarnation: crypto.randomUUID(), generation: 0 });
      return true;
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
    if (entry.operation.type === "field_photo.prepare") return false;
    return this.transaction("rw", [this.operations, this.metadata, this.jobs, this.drafts, this.cacheState, this.photos], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return false;
      if (result.status === "APPLIED" || (result.status === "DUPLICATE" && (!result.error_code || result.error_code === "DUPLICATE_COMPLETION"))) {
        await this.operations.delete(entry.sequence!);
        if (entry.operation.type === "field_task.evidence.attach") await this.photos.delete(`${fieldIdentity(scope)}:${entry.operation.client_op_id}`);
        if (entry.operation.type === "field_task.complete") {
          const key = fieldIdentity(scope), cacheId = `${key}:${entry.operation.payload.taskId}`;
          await this.jobs.delete(cacheId); await this.drafts.delete(cacheId);
          const state = await this.cacheState.get(key);
          await this.cacheState.put({ ...state, ...scope, key, incarnation: state?.incarnation ?? crypto.randomUUID(), generation: (state?.generation ?? 0) + 1 });
        }
      } else {
        await this.operations.update(entry.sequence!, { syncStatus: result.status === "CONFLICT" ? "conflict" : "rejected", result });
      }
      return true;
    });
  }

  async wipe(scope?: FieldQueueScope): Promise<void> {
    await this.transaction("rw", [this.operations, this.metadata, this.jobs, this.drafts, this.cacheState, this.photos], async () => {
      if (scope && (await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return;
      await this.operations.clear();
      await this.metadata.clear();
      await this.jobs.clear(); await this.drafts.clear(); await this.cacheState.clear();
      await this.photos.clear();
    });
  }

  async storePhoto(scope: FieldQueueScope, manifest: FieldUploadManifest, blob: Blob, incarnation: string): Promise<FieldQueueEntry> {
    // The UI queue validates the manifest before entering this storage layer,
    // matching store()/enqueue(); the worker needs no schema-parser bundle.
    const value = manifest, identity = fieldIdentity(scope), cacheId = `${identity}:${value.localId}`;
    if (blob.size !== value.size || blob.type !== value.contentType) throw new Error("FIELD_PHOTO_INVALID");
    return this.transaction("rw", [this.operations, this.metadata, this.jobs, this.cacheState, this.photos], async () => {
      if ((await this.metadata.get("identity"))?.value !== identity || (await this.cacheState.get(identity))?.incarnation !== incarnation)
        throw new Error("FIELD_SESSION_CHANGED");
      if (!(await this.jobs.get(`${identity}:${value.taskId}`))?.task.canEdit) throw new Error("FIELD_PHOTO_UNAVAILABLE");
      const existing = await this.photos.get(cacheId), entry = await this.operations.where("localId").equals(cacheId).first();
      if (existing) {
        if (JSON.stringify(existing.manifest) !== JSON.stringify(value) || !entry) throw new Error("FIELD_PHOTO_KEY_REUSED");
        return entry;
      }
      if (entry) throw new Error("FIELD_PHOTO_KEY_REUSED");
      const deviceId = (await this.metadata.get("device"))!.value;
      await this.photos.add({ ...scope, cacheId, taskId: value.taskId, manifest: value, blob, deviceId, incarnation,
        uploadedParts: [], ready: false, attempts: 0, retryAt: 0 });
      const record: FieldQueueEntry = { ...scope, localId: cacheId, deviceId, syncStatus: "pending", operation: { client_op_id: value.localId,
        type: "field_photo.prepare", client_created_at: new Date().toISOString(), payload: { taskId: value.taskId, photoLocalId: value.localId } } };
      record.sequence = await this.operations.add(record); return record;
    });
  }

  async photoSnapshot(scope: FieldQueueScope, taskId: string) {
    return this.transaction("r", [this.metadata, this.cacheState, this.jobs, this.photos, this.operations], async () => {
      const identity = fieldIdentity(scope);
      if ((await this.metadata.get("identity"))?.value !== identity) throw new Error("FIELD_SESSION_CHANGED");
      const state = await this.cacheState.get(identity), job = await this.jobs.get(`${identity}:${taskId}`);
      const photos = await this.photos.where("[organizationId+userId]").equals([scope.organizationId, scope.userId]).filter(row => row.taskId === taskId).toArray();
      const entries = await this.entries(scope);
      const completing = entries.some(entry => entry.operation.type === "field_task.complete" && entry.operation.payload.taskId === taskId && entry.syncStatus === "pending");
      return { incarnation: state?.incarnation ?? null, canEdit: Boolean(job?.task.canEdit) && !completing, photos: photos.map(photo => ({ ...photo,
        syncStatus: entries.find(entry => entry.operation.client_op_id === photo.manifest.localId)?.syncStatus ?? "pending" })) };
    });
  }

  async updatePhoto(scope: FieldQueueScope, localId: string, incarnation: string, update: {
    uploadId?: string; uploadedPart?: number; ready?: true; attempts?: number; retryAt?: number;
    review?: { status: "CONFLICT" | "REJECTED"; errorCode: string };
  }): Promise<boolean> {
    const identity = fieldIdentity(scope), cacheId = `${identity}:${localId}`;
    return this.transaction("rw", [this.operations, this.metadata, this.cacheState, this.photos], async () => {
      if ((await this.metadata.get("identity"))?.value !== identity || (await this.cacheState.get(identity))?.incarnation !== incarnation) return false;
      const photo = await this.photos.get(cacheId); if (!photo || photo.incarnation !== incarnation) return false;
      if (update.uploadId && photo.uploadId && update.uploadId !== photo.uploadId) throw new Error("FIELD_PHOTO_KEY_REUSED");
      const entry = await this.operations.where("localId").equals(cacheId).first(); if (!entry) return false;
      if (update.review) await this.operations.update(entry.sequence!, { syncStatus: update.review.status === "CONFLICT" ? "conflict" : "rejected",
        result: { client_op_id: localId, status: update.review.status, server_version: null, error_code: update.review.errorCode } });
      if (update.ready && !photo.uploadId && !update.uploadId) throw new Error("FIELD_PHOTO_NOT_READY");
      if (update.uploadId && entry.operation.type === "field_photo.prepare") await this.operations.update(entry.sequence!, { operation: {
        client_op_id: entry.operation.client_op_id, type: "field_task.evidence.attach", client_created_at: entry.operation.client_created_at,
        payload: { taskId: photo.taskId, uploadId: update.uploadId }
      } });
      const parts = [...photo.uploadedParts];
      if (update.uploadedPart !== undefined) {
        if (!Number.isInteger(update.uploadedPart) || update.uploadedPart < 0 || update.uploadedPart >= photo.manifest.parts.length) throw new Error("FIELD_PHOTO_PART_INVALID");
        if (!parts.includes(update.uploadedPart)) parts.push(update.uploadedPart);
      }
      await this.photos.put({ ...photo, uploadId: update.uploadId ?? photo.uploadId, uploadedParts: parts.sort((a, b) => a - b),
        ready: update.ready ?? photo.ready, attempts: update.attempts ?? (update.ready ? 0 : photo.attempts), retryAt: update.retryAt ?? (update.ready ? 0 : photo.retryAt) });
      return true;
    });
  }

  async cachedJobs(scope: FieldQueueScope): Promise<FieldWorkSnapshot[]> {
    return (await this.readCache(scope)).tasks;
  }

  async readCache(scope: FieldQueueScope): Promise<{ tasks: FieldWorkSnapshot[]; state?: FieldCacheState }> {
    return this.transaction("r", [this.metadata, this.jobs, this.cacheState], async () => {
      const key = fieldIdentity(scope);
      if ((await this.metadata.get("identity"))?.value !== key) throw new Error("FIELD_SESSION_CHANGED");
      const rows = await this.jobs.where("[organizationId+userId]").equals([scope.organizationId, scope.userId]).toArray();
      return { tasks: rows.map(row => row.task), state: await this.cacheState.get(key) };
    });
  }

  async invalidateCache(scope: FieldQueueScope): Promise<void> {
    await this.transaction("rw", [this.metadata, this.jobs, this.drafts, this.cacheState], async () => {
      const key = fieldIdentity(scope);
      if ((await this.metadata.get("identity"))?.value !== key) return;
      const state = await this.cacheState.get(key);
      await this.jobs.clear(); await this.drafts.clear();
      await this.cacheState.put({ ...scope, key, incarnation: state?.incarnation ?? crypto.randomUUID(), generation: (state?.generation ?? 0) + 1, invalidated: true });
    });
  }

  async readDraft(scope: FieldQueueScope, taskId: string): Promise<FieldDraft | undefined> {
    return this.transaction("r", [this.metadata, this.drafts], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      return this.drafts.get(`${fieldIdentity(scope)}:${taskId}`);
    });
  }

  async saveDraft(scope: FieldQueueScope, taskId: string, checklistItemIds: string[], note: string, incarnation: string): Promise<boolean> {
    return this.transaction("rw", [this.metadata, this.drafts, this.jobs, this.cacheState], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      if ((await this.cacheState.get(fieldIdentity(scope)))?.incarnation !== incarnation) throw new Error("FIELD_SESSION_CHANGED");
      const cacheId = `${fieldIdentity(scope)}:${taskId}`;
      if (!await this.jobs.get(cacheId)) return false;
      await this.drafts.put({ ...scope, cacheId, taskId, checklistItemIds, note, savedAt: new Date().toISOString() });
      return true;
    });
  }

  /** Publish the whole validated pull atomically; an intervening completion invalidates it. */
  async publishCache(scope: FieldQueueScope, revision: FieldCacheRevision, tasks: FieldWorkSnapshot[], tombstones: string[], cursor: string, snapshotAt: string): Promise<boolean> {
    return this.transaction("rw", [this.metadata, this.jobs, this.drafts, this.cacheState], async () => {
      const key = fieldIdentity(scope), state = await this.cacheState.get(key);
      if ((await this.metadata.get("identity"))?.value !== key) throw new Error("FIELD_SESSION_CHANGED");
      if (state?.generation !== revision.generation || state.incarnation !== revision.incarnation) return false;
      await this.jobs.bulkPut(tasks.map(task => ({ ...scope, cacheId: `${key}:${task.id}`, task })));
      const removed = tombstones.map(id => `${key}:${id}`);
      await this.jobs.bulkDelete(removed); await this.drafts.bulkDelete(removed);
      await this.cacheState.put({ ...scope, key, incarnation: revision.incarnation, generation: revision.generation + 1, cursor, snapshotAt });
      return true;
    });
  }

}
