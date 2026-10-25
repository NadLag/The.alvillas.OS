import { fieldIdentity, type FieldPhoto, type FieldQueueEntry, type FieldQueueScope, type FieldQueueStore } from "./field-queue-store";
import { isUploadGeneration } from "@/platform/storage/upload-generation";

class PhotoResponseError extends Error {
  constructor(readonly status: number, readonly errorCode?: string) { super("FIELD_PHOTO_RESPONSE"); }
}
async function responseError(response: Response) {
  let code: string | undefined;
  try { const value: unknown = await response.json(); if (value && typeof value === "object" && "error" in value && typeof value.error === "string") code = value.error; } catch { /* No response body is required. */ }
  return new PhotoResponseError(response.status, code);
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
function uploadResult(value: unknown): { uploadId: string; status: string; generation: number } {
  if (!value || typeof value !== "object" || !("uploadId" in value) || typeof value.uploadId !== "string" || !uuid.test(value.uploadId) ||
    !("status" in value) || typeof value.status !== "string" || !["OPEN", "READY", "ATTACHED"].includes(value.status)) throw new Error("FIELD_PHOTO_RESPONSE");
  const generation = "generation" in value ? value.generation : 1;
  if (!isUploadGeneration(generation)) throw new Error("FIELD_PHOTO_RESPONSE");
  return { uploadId: value.uploadId, status: value.status, generation };
}

/** Resume transport before its business operation; original wire keys never change. */
export async function prepareQueuedPhoto(queue: FieldQueueStore, scope: FieldQueueScope, entry: FieldQueueEntry, send: typeof fetch,
  now: () => number = Date.now): Promise<FieldQueueEntry | "queued" | "rejected" | null> {
  const key = fieldIdentity(scope), localId = entry.operation.client_op_id;
  const photo = await queue.photos.get(`${key}:${localId}`);
  if (!photo) return entry.operation.type === "field_photo.prepare" ? "queued" : entry;
  const current = async () => (await queue.metadata.get("identity"))?.value === key &&
    (await queue.cacheState.get(key))?.incarnation === photo.incarnation && Boolean(await queue.photos.get(photo.cacheId));
  if (!await current()) return "rejected";
  if (photo.retryAt > now()) return "queued";
  let generation = photo.generation ?? 1;
  const envelope = { organization_id: scope.organizationId, actor_user_id: scope.userId, device_id: photo.deviceId };
  const json = async (path: string, body: unknown) => {
    if (!await current()) throw new PhotoResponseError(401);
    const response = await send(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<unknown>;
  };
  try {
    if (!photo.ready) {
      // An idempotent start also recovers a lost completion acknowledgement or
      // progress made by another tab/worker without repeating a business action.
      const started = uploadResult(await json("/api/field/uploads", { ...envelope, manifest: photo.manifest, include_generation: true }));
      if (!await queue.updatePhoto(scope, localId, photo.incarnation, { uploadId: started.uploadId, generation: started.generation,
        ...(started.status !== "OPEN" ? { ready: true, attempts: 0, retryAt: 0 } : {}) })) return "rejected";
      generation = started.generation;
      if (started.status === "OPEN") {
        let offset = 0;
        for (let index = 0; index < photo.manifest.parts.length; index++) {
          const part = photo.manifest.parts[index], from = offset; offset += part.size;
          const latest = await queue.photos.get(photo.cacheId);
          if (!latest || !await current() || (latest.generation ?? 1) !== generation) return "rejected";
          if (latest.uploadedParts.includes(index)) continue;
          const params = new URLSearchParams({ ...envelope, uploadId: started.uploadId, index: String(index), generation: String(generation) });
          const response = await send(`/api/field/uploads/part?${params}`, { method: "PUT", credentials: "same-origin",
            headers: { "Content-Type": "application/octet-stream" }, body: photo.blob.slice(from, from + part.size) });
          if (!response.ok) throw await responseError(response);
          const result: unknown = await response.json();
          if (!result || typeof result !== "object" || !("stored" in result) || result.stored !== true) throw new Error("FIELD_PHOTO_RESPONSE");
          if (!await queue.updatePhoto(scope, localId, photo.incarnation, { uploadedPart: index }, { expectedGeneration: generation })) return "rejected";
        }
        const completed = uploadResult(await json("/api/field/uploads/complete", { ...envelope, uploadId: started.uploadId, generation }));
        if (completed.uploadId !== started.uploadId || completed.status === "OPEN") throw new Error("FIELD_PHOTO_RESPONSE");
        if (completed.generation !== generation) throw new PhotoResponseError(409, "upload_generation_changed");
        if (!await queue.updatePhoto(scope, localId, photo.incarnation, { ready: true, attempts: 0, retryAt: 0 }, { expectedGeneration: generation })) return "rejected";
      }
    }
    if (!await current()) return "rejected";
    return await queue.operations.where("localId").equals(entry.localId).first() ?? null;
  } catch (error) {
    if (error instanceof PhotoResponseError && error.status === 409 && error.errorCode === "upload_generation_changed") {
      await delayPhotoRetry(queue, scope, photo, now(), generation); return "queued";
    }
    if (error instanceof PhotoResponseError && error.status === 401) {
      // A late response from an old incarnation cannot wipe a new sign-in.
      if (await current()) await queue.wipe(scope);
      return "rejected";
    }
    if (error instanceof PhotoResponseError && [400, 403, 404, 409, 413].includes(error.status)) {
      await queue.updatePhoto(scope, localId, photo.incarnation, { review: { status: error.status === 409 ? "CONFLICT" : "REJECTED",
        errorCode: error.status === 403 ? "REJECTED_FORBIDDEN" : error.status === 404 ? "REJECTED_NOT_ASSIGNED" : "REJECTED_PHOTO_UPLOAD" } }, { expectedGeneration: generation });
      return "rejected";
    }
    await delayPhotoRetry(queue, scope, photo, now(), generation);
    return "queued";
  }
}

async function delayPhotoRetry(queue: FieldQueueStore, scope: FieldQueueScope, photo: FieldPhoto, now: number, generation: number) {
  const latest = await queue.photos.get(photo.cacheId), attempts = (latest?.attempts ?? photo.attempts) + 1;
  // Transport backoff, independent of business schedules and property policy.
  const delay = Math.min(60000, 1000 * 2 ** Math.min(attempts - 1, 6));
  await queue.updatePhoto(scope, photo.manifest.localId, photo.incarnation, { attempts, retryAt: now + delay }, { expectedGeneration: generation });
}
