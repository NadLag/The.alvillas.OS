import Dexie, { type Table } from "dexie";
import type { SyncPushOp, SyncPushOpResult } from "@/modules/reservations/domain/sync-protocol";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import type { FieldUploadManifest } from "@/modules/reservations/domain/field-upload";
import { isUploadGeneration } from "@/platform/storage/upload-generation";
import type { FieldDevicePolicySnapshot } from "@/platform/config/field-device-policy";

export type FieldQueueScope = { organizationId: string; userId: string };
export type FieldCacheAudience = "assigned" | "supervised";
export type FieldProxyDraftInput = Extract<SyncPushOp, { type: "field_task.proxy_validate" }>["payload"] & { clientOpId: string };
export type FieldProxyDraft = FieldQueueScope & FieldProxyDraftInput & { cacheId: string; savedAt: string; supersedesClientOpId?: string };
export type FieldProxyOperation = Extract<SyncPushOp, { type: "field_task.proxy_validate" }>;
type PendingPhotoOperation = { client_op_id: string; type: "field_photo.prepare"; client_created_at: string;
  payload: { taskId: string; photoLocalId: string } };
export type FieldQueueEntry = FieldQueueScope & {
  localId: string;
  deviceId: string;
  sequence?: number;
  operation: SyncPushOp | PendingPhotoOperation;
  syncStatus: "pending" | "conflict" | "rejected";
  result?: SyncPushOpResult;
  supersedesClientOpId?: string;
  resolvedByClientOpId?: string;
  devicePolicy?: FieldDevicePolicySnapshot | null;
};
type Metadata = { key: string; value: string };
export type FieldCachedJob = FieldQueueScope & { cacheId: string; task: FieldWorkSnapshot };
export type FieldDraft = FieldQueueScope & { cacheId: string; taskId: string; checklistItemIds: string[]; note: string; savedAt: string };
export type FieldCacheRevision = { incarnation: string; generation: number };
export type FieldCacheState = FieldQueueScope & FieldCacheRevision & { key: string; snapshotAt?: string; cursor?: string; invalidated?: boolean };
export type FieldPhoto = FieldQueueScope & { cacheId: string; taskId: string; manifest: FieldUploadManifest; blob: Blob; deviceId: string;
  incarnation: string; uploadId?: string; generation?: number; uploadedParts: number[]; ready: boolean; attempts: number; retryAt: number };
export type QueueOutcome = "idle" | "synced" | "conflict" | "rejected" | "queued";
export const fieldIdentity = (scope: FieldQueueScope) => `${scope.organizationId}:${scope.userId}`;
export const fieldCacheIdentity = (scope: FieldQueueScope, audience: FieldCacheAudience = "assigned") =>
  fieldIdentity(scope) + (audience === "supervised" ? ":supervised" : "");
export function isFieldResultApplied(type: FieldQueueEntry["operation"]["type"], result: SyncPushOpResult): boolean {
  return result.status === "APPLIED" || (result.status === "DUPLICATE" &&
    (!result.error_code || (type === "field_task.complete" && result.error_code === "DUPLICATE_COMPLETION")));
}

export class FieldQueueStore extends Dexie {
  operations!: Table<FieldQueueEntry, number>;
  metadata!: Table<Metadata, string>;
  jobs!: Table<FieldCachedJob, string>;
  drafts!: Table<FieldDraft, string>;
  cacheState!: Table<FieldCacheState, string>;
  photos!: Table<FieldPhoto, string>;
  proxyJobs!: Table<FieldCachedJob, string>;
  proxyDrafts!: Table<FieldProxyDraft, string>;

  constructor(name = "alvillas.field.v1") {
    super(name);
    this.version(1).stores({ operations: "++sequence,&localId,[organizationId+userId]", metadata: "key" });
    this.version(2).stores({ jobs: "&cacheId,[organizationId+userId]", drafts: "&cacheId,[organizationId+userId]", cacheState: "key" });
    this.version(3).stores({ photos: "&cacheId,[organizationId+userId],taskId" });
    this.version(4).stores({ proxyJobs: "&cacheId,[organizationId+userId]", proxyDrafts: "&cacheId,[organizationId+userId]" });
  }

  async activate(scope: FieldQueueScope): Promise<void> {
    await this.activateWhenCurrent(scope);
  }

  async activateIfCurrent(scope: FieldQueueScope, expectedIdentity: string | null): Promise<boolean> {
    return this.activateWhenCurrent(scope, expectedIdentity);
  }

  private async activateWhenCurrent(scope: FieldQueueScope, expectedIdentity?: string | null): Promise<boolean> {
    return this.transaction("rw", [this.operations, this.metadata, this.jobs, this.drafts, this.cacheState, this.photos, this.proxyJobs, this.proxyDrafts], async () => {
      const current = await this.metadata.get("identity");
      if (expectedIdentity !== undefined && (current?.value ?? null) !== expectedIdentity && current?.value !== fieldIdentity(scope)) return false;
      if (current?.value !== fieldIdentity(scope)) {
        await this.operations.clear();
        await this.jobs.clear(); await this.drafts.clear(); await this.cacheState.clear();
        await this.photos.clear();
        await this.proxyJobs.clear(); await this.proxyDrafts.clear();
        await this.metadata.put({ key: "identity", value: fieldIdentity(scope) });
      }
      if (!await this.metadata.get("device")) {
        await this.metadata.put({ key: "device", value: crypto.randomUUID() });
      }
      await this.prepareCache(scope);
      return true;
    });
  }

  async prepareCache(scope: FieldQueueScope, audience: FieldCacheAudience = "assigned"): Promise<FieldCacheState> {
    return this.transaction("rw", [this.metadata, this.cacheState], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      const key = fieldCacheIdentity(scope, audience), existing = await this.cacheState.get(key);
      if (existing) return existing;
      const state: FieldCacheState = { ...scope, key, incarnation: crypto.randomUUID(), generation: 0 };
      await this.cacheState.put(state); return state;
    });
  }

  async entries(scope: FieldQueueScope): Promise<FieldQueueEntry[]> {
    return this.operations.where("[organizationId+userId]").equals([scope.organizationId, scope.userId]).sortBy("sequence");
  }

  async store(scope: FieldQueueScope, operation: SyncPushOp, deviceId?: string): Promise<FieldQueueEntry> {
    const parsed = operation;
    const jobs = operation.type === "field_task.proxy_validate" ? this.proxyJobs : this.jobs;
    return this.transaction("rw", [this.operations, this.metadata, jobs], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      const localId = `${fieldIdentity(scope)}:${parsed.client_op_id}`;
      const existing = await this.operations.where("localId").equals(localId).first();
      if (existing) return existing;
      const task = (await jobs.get(`${fieldIdentity(scope)}:${parsed.payload.taskId}`))?.task;
      const item: FieldQueueEntry = { ...scope, localId, deviceId: deviceId ?? (await this.metadata.get("device"))!.value,
        operation: parsed, syncStatus: "pending", ...(task?.devicePolicy !== undefined ? { devicePolicy: task.devicePolicy } : {}) };
      item.sequence = await this.operations.add(item);
      return item;
    });
  }

  async acknowledge(scope: FieldQueueScope, entry: FieldQueueEntry, result: SyncPushOpResult): Promise<boolean> {
    if (entry.operation.type === "field_photo.prepare" || result.client_op_id !== entry.operation.client_op_id) return false;
    return this.transaction("rw", [this.operations, this.metadata, this.jobs, this.drafts, this.cacheState, this.photos, this.proxyJobs, this.proxyDrafts], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return false;
      const current = entry.sequence === undefined ? undefined : await this.operations.get(entry.sequence);
      if (!current) return true;
      if (current.localId !== entry.localId || current.deviceId !== entry.deviceId || JSON.stringify(current.operation) !== JSON.stringify(entry.operation)) return false;
      if (isFieldResultApplied(entry.operation.type, result)) {
        await this.operations.delete(entry.sequence!);
        if (entry.operation.type === "field_task.evidence.attach") await this.photos.delete(`${fieldIdentity(scope)}:${entry.operation.client_op_id}`);
        if (entry.operation.type === "field_task.complete" || entry.operation.type === "field_task.proxy_validate") {
          const audience = entry.operation.type === "field_task.proxy_validate" ? "supervised" : "assigned";
          const key = fieldCacheIdentity(scope, audience), cacheId = `${fieldIdentity(scope)}:${entry.operation.payload.taskId}`;
          const jobs = audience === "supervised" ? this.proxyJobs : this.jobs, drafts = audience === "supervised" ? this.proxyDrafts : this.drafts;
          await jobs.delete(cacheId); await drafts.delete(cacheId);
          const state = await this.cacheState.get(key);
          await this.cacheState.put({ ...state, ...scope, key, incarnation: state?.incarnation ?? crypto.randomUUID(), generation: (state?.generation ?? 0) + 1 });
          if (audience === "supervised") {
            let previousId = entry.supersedesClientOpId; const visited = new Set<string>();
            while (previousId && !visited.has(previousId)) {
              visited.add(previousId);
              const previous = await this.operations.where("localId").equals(`${fieldIdentity(scope)}:${previousId}`).first();
              if (!previous || previous.organizationId !== scope.organizationId || previous.userId !== scope.userId || previous.syncStatus === "pending" ||
                previous.operation.type !== "field_task.proxy_validate" || previous.operation.payload.taskId !== entry.operation.payload.taskId) break;
              await this.operations.update(previous.sequence!, { resolvedByClientOpId: entry.operation.client_op_id });
              previousId = previous.supersedesClientOpId;
            }
          }
        }
      } else {
        await this.operations.update(entry.sequence!, { syncStatus: result.status === "CONFLICT" ? "conflict" : "rejected", result });
      }
      return true;
    });
  }

  async wipe(scope?: FieldQueueScope): Promise<void> {
    await this.transaction("rw", [this.operations, this.metadata, this.jobs, this.drafts, this.cacheState, this.photos, this.proxyJobs, this.proxyDrafts], async () => {
      if (scope && (await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return;
      await this.operations.clear();
      await this.metadata.clear();
      await this.jobs.clear(); await this.drafts.clear(); await this.cacheState.clear();
      await this.photos.clear();
      await this.proxyJobs.clear(); await this.proxyDrafts.clear();
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
      const task = (await this.jobs.get(`${identity}:${value.taskId}`))?.task;
      if (!task?.canEdit) throw new Error("FIELD_PHOTO_UNAVAILABLE");
      const existing = await this.photos.get(cacheId), entry = await this.operations.where("localId").equals(cacheId).first();
      if (existing) {
        if (JSON.stringify(existing.manifest) !== JSON.stringify(value) || !entry) throw new Error("FIELD_PHOTO_KEY_REUSED");
        return entry;
      }
      if (entry) throw new Error("FIELD_PHOTO_KEY_REUSED");
      const deviceId = (await this.metadata.get("device"))!.value;
      await this.photos.add({ ...scope, cacheId, taskId: value.taskId, manifest: value, blob, deviceId, incarnation,
        uploadedParts: [], ready: false, attempts: 0, retryAt: 0 });
      const record: FieldQueueEntry = { ...scope, localId: cacheId, deviceId, syncStatus: "pending",
        ...(task.devicePolicy !== undefined ? { devicePolicy: task.devicePolicy } : {}), operation: { client_op_id: value.localId,
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
    uploadId?: string; generation?: number; uploadedPart?: number; ready?: true; attempts?: number; retryAt?: number;
    review?: { status: "CONFLICT" | "REJECTED"; errorCode: string };
  }, options: { expectedGeneration?: number } = {}): Promise<boolean> {
    const identity = fieldIdentity(scope), cacheId = `${identity}:${localId}`;
    return this.transaction("rw", [this.operations, this.metadata, this.cacheState, this.photos], async () => {
      if ((await this.metadata.get("identity"))?.value !== identity || (await this.cacheState.get(identity))?.incarnation !== incarnation) return false;
      const photo = await this.photos.get(cacheId); if (!photo || photo.incarnation !== incarnation) return false;
      const generation = photo.generation ?? 1;
      if (options.expectedGeneration !== undefined && options.expectedGeneration !== generation) return false;
      if (update.generation !== undefined && (!isUploadGeneration(update.generation) || update.generation < generation)) return false;
      const recovered = update.generation !== undefined && update.generation > generation;
      if (update.uploadId && photo.uploadId && update.uploadId !== photo.uploadId) throw new Error("FIELD_PHOTO_KEY_REUSED");
      const entry = await this.operations.where("localId").equals(cacheId).first(); if (!entry) return false;
      if (update.review) await this.operations.update(entry.sequence!, { syncStatus: update.review.status === "CONFLICT" ? "conflict" : "rejected",
        result: { client_op_id: localId, status: update.review.status, server_version: null, error_code: update.review.errorCode } });
      if (update.ready && !photo.uploadId && !update.uploadId) throw new Error("FIELD_PHOTO_NOT_READY");
      if (update.uploadId && entry.operation.type === "field_photo.prepare") await this.operations.update(entry.sequence!, { operation: {
        client_op_id: entry.operation.client_op_id, type: "field_task.evidence.attach", client_created_at: entry.operation.client_created_at,
        payload: { taskId: photo.taskId, uploadId: update.uploadId }
      } });
      const parts = recovered ? [] : [...photo.uploadedParts];
      if (update.uploadedPart !== undefined) {
        if (!Number.isInteger(update.uploadedPart) || update.uploadedPart < 0 || update.uploadedPart >= photo.manifest.parts.length) throw new Error("FIELD_PHOTO_PART_INVALID");
        if (!parts.includes(update.uploadedPart)) parts.push(update.uploadedPart);
      }
      await this.photos.put({ ...photo, uploadId: update.uploadId ?? photo.uploadId, ...(update.generation !== undefined ? { generation: update.generation } : {}),
        uploadedParts: parts.sort((a, b) => a - b), ready: update.ready ?? (recovered ? false : photo.ready),
        attempts: update.attempts ?? (update.ready || recovered ? 0 : photo.attempts), retryAt: update.retryAt ?? (update.ready || recovered ? 0 : photo.retryAt) });
      return true;
    });
  }

  async cachedJobs(scope: FieldQueueScope, audience: FieldCacheAudience = "assigned"): Promise<FieldWorkSnapshot[]> {
    return (await this.readCache(scope, audience)).tasks;
  }

  async readCache(scope: FieldQueueScope, audience: FieldCacheAudience = "assigned"): Promise<{ tasks: FieldWorkSnapshot[]; state?: FieldCacheState }> {
    const jobs = audience === "supervised" ? this.proxyJobs : this.jobs;
    return this.transaction("r", [this.metadata, jobs, this.cacheState], async () => {
      const key = fieldCacheIdentity(scope, audience);
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      const rows = await jobs.where("[organizationId+userId]").equals([scope.organizationId, scope.userId]).toArray();
      return { tasks: rows.map(row => row.task), state: await this.cacheState.get(key) };
    });
  }

  async invalidateCache(scope: FieldQueueScope, audience: FieldCacheAudience = "assigned"): Promise<void> {
    const jobs = audience === "supervised" ? this.proxyJobs : this.jobs, drafts = audience === "supervised" ? this.proxyDrafts : this.drafts;
    await this.transaction("rw", [this.metadata, jobs, drafts, this.cacheState], async () => {
      const key = fieldCacheIdentity(scope, audience);
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) return;
      const state = await this.cacheState.get(key);
      await jobs.clear(); await drafts.clear();
      await this.cacheState.put({ ...scope, key, incarnation: state?.incarnation ?? crypto.randomUUID(), generation: (state?.generation ?? 0) + 1, invalidated: true });
    });
  }

  async readProxyDraft(scope: FieldQueueScope, taskId: string): Promise<FieldProxyDraft | undefined> {
    return this.transaction("r", [this.metadata, this.proxyDrafts], async () => {
      if ((await this.metadata.get("identity"))?.value !== fieldIdentity(scope)) throw new Error("FIELD_SESSION_CHANGED");
      return this.proxyDrafts.get(`${fieldIdentity(scope)}:${taskId}`);
    });
  }

  async proxySnapshot(scope: FieldQueueScope, taskId: string) {
    return this.transaction("r", [this.metadata, this.proxyDrafts, this.proxyJobs, this.cacheState, this.operations], async () => {
      const identity = fieldIdentity(scope);
      if ((await this.metadata.get("identity"))?.value !== identity) throw new Error("FIELD_SESSION_CHANGED");
      return { state: await this.cacheState.get(fieldCacheIdentity(scope, "supervised")), task: (await this.proxyJobs.get(`${identity}:${taskId}`))?.task,
        draft: await this.proxyDrafts.get(`${identity}:${taskId}`), entries: (await this.entries(scope)).filter(entry =>
          entry.operation.type === "field_task.proxy_validate" && entry.operation.payload.taskId === taskId) };
    });
  }

  async storeProxyOperation(scope: FieldQueueScope, operation: FieldProxyOperation, incarnation: string): Promise<FieldQueueEntry> {
    return this.transaction("rw", [this.metadata, this.proxyDrafts, this.proxyJobs, this.cacheState, this.operations], async () => {
      const identity = fieldIdentity(scope), value = operation.payload, cacheId = `${identity}:${value.taskId}`;
      if ((await this.metadata.get("identity"))?.value !== identity || (await this.cacheState.get(fieldCacheIdentity(scope, "supervised")))?.incarnation !== incarnation)
        throw new Error("FIELD_SESSION_CHANGED");
      const draft = await this.proxyDrafts.get(cacheId);
      if (!draft || draft.clientOpId !== operation.client_op_id || draft.expectedVersion !== value.expectedVersion || draft.performedByPersonId !== value.performedByPersonId)
        throw new Error("FIELD_PROXY_REVIEW_REQUIRED");
      const existing = await this.operations.where("localId").equals(`${identity}:${operation.client_op_id}`).first();
      if (existing) {
        if (existing.operation.type !== "field_task.proxy_validate" || JSON.stringify(existing.operation.payload) !== JSON.stringify(value))
          throw new Error("FIELD_PROXY_OPERATION_PENDING");
        return existing;
      }
      if (!(await this.proxyJobs.get(cacheId))?.task.proxyValidation) throw new Error("FIELD_PROXY_UNAVAILABLE");
      await this.proxyDrafts.put({ ...draft, checklistItemIds: value.checklistItemIds, reason: value.reason, savedAt: new Date().toISOString() });
      const entry = await this.store(scope, operation);
      if (draft.supersedesClientOpId) {
        entry.supersedesClientOpId = draft.supersedesClientOpId;
        await this.operations.update(entry.sequence!, { supersedesClientOpId: draft.supersedesClientOpId });
      }
      return entry;
    });
  }

  async saveProxyDraft(scope: FieldQueueScope, value: FieldProxyDraftInput, incarnation: string): Promise<boolean> {
    return this.writeProxyDraft(scope, value, incarnation);
  }

  async reviewProxyDraft(scope: FieldQueueScope, value: FieldProxyDraftInput, previousClientOpId: string, incarnation: string): Promise<boolean> {
    return this.writeProxyDraft(scope, value, incarnation, previousClientOpId);
  }

  private async writeProxyDraft(scope: FieldQueueScope, value: FieldProxyDraftInput, incarnation: string, previousClientOpId?: string): Promise<boolean> {
    return this.transaction("rw", [this.metadata, this.proxyDrafts, this.proxyJobs, this.cacheState, this.operations], async () => {
      const identity = fieldIdentity(scope);
      if ((await this.metadata.get("identity"))?.value !== identity || (await this.cacheState.get(fieldCacheIdentity(scope, "supervised")))?.incarnation !== incarnation)
        throw new Error("FIELD_SESSION_CHANGED");
      const cacheId = `${identity}:${value.taskId}`, task = (await this.proxyJobs.get(cacheId))?.task;
      if (!task?.proxyValidation) return false;
      const existing = await this.proxyDrafts.get(cacheId);
      let previousOperation: FieldQueueEntry | undefined;
      if (existing) {
        previousOperation = await this.operations.where("localId").equals(`${identity}:${existing.clientOpId}`).first();
        if (previousOperation?.syncStatus === "pending") throw new Error("FIELD_PROXY_OPERATION_PENDING");
        if (previousClientOpId === undefined && (existing.clientOpId !== value.clientOpId || existing.expectedVersion !== value.expectedVersion || existing.performedByPersonId !== value.performedByPersonId))
          throw new Error("FIELD_PROXY_REVIEW_REQUIRED");
      }
      if (previousClientOpId !== undefined && (!existing || existing.clientOpId !== previousClientOpId || value.clientOpId === previousClientOpId))
        throw new Error("FIELD_PROXY_REVIEW_REQUIRED");
      if (!existing || previousClientOpId !== undefined) {
        if (task.proxyValidation.expectedVersion !== value.expectedVersion || task.proxyValidation.performedByPersonId !== value.performedByPersonId ||
          value.checklistItemIds.some(id => !task.checklistItems.some(item => item.id === id))) throw new Error("FIELD_PROXY_REVIEW_REQUIRED");
      }
      await this.proxyDrafts.put({ ...scope, cacheId, taskId: value.taskId, clientOpId: value.clientOpId, expectedVersion: value.expectedVersion,
        performedByPersonId: value.performedByPersonId, checklistItemIds: value.checklistItemIds, reason: value.reason, savedAt: new Date().toISOString(),
        supersedesClientOpId: previousClientOpId && previousOperation ? previousClientOpId : existing?.supersedesClientOpId });
      return true;
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
  async publishCache(scope: FieldQueueScope, revision: FieldCacheRevision, tasks: FieldWorkSnapshot[], tombstones: string[], cursor: string, snapshotAt: string, audience: FieldCacheAudience = "assigned"): Promise<boolean> {
    const jobs = audience === "supervised" ? this.proxyJobs : this.jobs, drafts = audience === "supervised" ? this.proxyDrafts : this.drafts;
    return this.transaction("rw", [this.metadata, jobs, drafts, this.cacheState], async () => {
      const key = fieldCacheIdentity(scope, audience), identity = fieldIdentity(scope), state = await this.cacheState.get(key);
      if ((await this.metadata.get("identity"))?.value !== identity) throw new Error("FIELD_SESSION_CHANGED");
      if (state?.generation !== revision.generation || state.incarnation !== revision.incarnation) return false;
      await jobs.bulkPut(tasks.map(task => ({ ...scope, cacheId: `${identity}:${task.id}`, task })));
      const removed = tombstones.map(id => `${identity}:${id}`);
      await jobs.bulkDelete(removed); await drafts.bulkDelete(removed);
      await this.cacheState.put({ ...scope, key, incarnation: revision.incarnation, generation: revision.generation + 1, cursor, snapshotAt });
      return true;
    });
  }

}
