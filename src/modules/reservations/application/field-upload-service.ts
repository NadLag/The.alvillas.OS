import { z } from "zod";
import { createHash } from "node:crypto";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { R2StorageProvider } from "@/platform/providers/real";
import type { StorageProvider } from "@/platform/providers";
import { FieldUploadRepository } from "../infrastructure/field-upload-repository";
import { OperationRepository } from "../infrastructure/operation-repository";
import { fieldUploadManifestSchema, fieldUploadPartStorageKey } from "../domain/field-upload";
import { syncPushInputSchema } from "../domain/sync-protocol";
import type { ReservationActorContext } from "./reservation-access";
import { operationAllowed, operationHash, operationMeta, taskResource, type OperationDeps, type OperationTask } from "./operation-service";
import { ReservationAuthorizationError, ReservationConflictError, ReservationNotFoundError } from "./reservation-service";
import { validEvidenceImage, persistOperationEvidence } from "./operation-evidence";
import { readExactResponseBytes } from "@/platform/http/read-exact-response";

type UploadDeps = OperationDeps & { storage?: StorageProvider; transport?: typeof fetch };
type CompleteUploadDeps = UploadDeps & { storage?: StorageProvider & {
  createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }>;
} };
export class FieldUploadUnavailableError extends Error {
  constructor() { super("operation_storage_unavailable"); this.name = "FieldUploadUnavailableError"; }
}
export const fieldUploadCreateSchema = z.object({ organization_id: syncPushInputSchema.shape.organization_id,
  actor_user_id: syncPushInputSchema.shape.actor_user_id, device_id: syncPushInputSchema.shape.device_id,
  manifest: fieldUploadManifestSchema }).strict();
const partRequestSchema = z.object({ organization_id: syncPushInputSchema.shape.organization_id,
  actor_user_id: syncPushInputSchema.shape.actor_user_id, device_id: syncPushInputSchema.shape.device_id,
  uploadId: z.uuid(), index: z.number().int().nonnegative() }).strict();
const completeRequestSchema = partRequestSchema.omit({ index: true });

function checkOwner(ctx: ReservationActorContext, value: { organization_id: string; actor_user_id: string }) {
  if (value.organization_id !== ctx.organizationId || value.actor_user_id !== ctx.actorId) throw new ReservationAuthorizationError();
}
function assigned(ctx: ReservationActorContext, task: OperationTask | null): asserts task is OperationTask {
  if (!task || task.assignedToUserAccountId !== ctx.actorId || task.assignedToPersonId !== ctx.personId) throw new ReservationNotFoundError();
  operationAllowed(ctx, "edit", taskResource(task));
}

export async function startFieldUpload(ctx: ReservationActorContext, input: unknown, deps: UploadDeps = {}) {
  operationAllowed(ctx, "edit"); const value = fieldUploadCreateSchema.parse(input); checkOwner(ctx, value);
  const meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const operations = new OperationRepository(tx, ctx.organizationId), uploads = new FieldUploadRepository(tx, ctx.organizationId);
    // Same order as native evidence and assignment; no network work holds these locks.
    await operations.lock("crew-schedule"); await operations.lock(value.manifest.taskId); await uploads.lock(`${ctx.actorId}:${value.manifest.localId}`);
    const task = await operations.task(value.manifest.taskId); assigned(ctx, task);
    const policy = await operations.policy(task.propertyId);
    if (value.manifest.size > policy.evidence_max_bytes) throw new ReservationConflictError("operation_photo_too_large");
    const hash = operationHash({ deviceId: value.device_id, manifest: value.manifest }), existing = await uploads.byLocalId(ctx.actorId, value.manifest.localId);
    if (existing) {
      if (existing.manifestHash !== hash || existing.taskId !== task.id || existing.deviceId !== value.device_id || existing.status === "CANCELLED")
        throw new ReservationConflictError("upload_idempotency_key_reused");
      return { uploadId: existing.id, status: existing.status };
    }
    const upload = await uploads.create(ctx.actorId, value.device_id, value.manifest, hash);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "task.photo.upload.started", resourceType: "task",
      resourceId: task.id, propertyScopeId: task.propertyId, before: null,
      after: { uploadId: upload.id, contentType: value.manifest.contentType, size: value.manifest.size, sha256: value.manifest.sha256 },
      reason: value.manifest.note, ...meta, occurredAt: deps.now ?? new Date() });
    return { uploadId: upload.id, status: upload.status };
  });
}

export async function signFieldUploadPart(ctx: ReservationActorContext, input: unknown, deps: UploadDeps = {}, bytes?: Uint8Array) {
  operationAllowed(ctx, "edit"); const value = partRequestSchema.parse(input); checkOwner(ctx, value);
  const key = await withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const uploads = new FieldUploadRepository(tx, ctx.organizationId), operations = new OperationRepository(tx, ctx.organizationId);
    const upload = await uploads.get(value.uploadId);
    if (!upload || upload.actorId !== ctx.actorId || upload.deviceId !== value.device_id) throw new ReservationNotFoundError();
    const task = await operations.task(upload.taskId); assigned(ctx, task);
    const manifest = fieldUploadManifestSchema.parse(upload.manifest), policy = await operations.policy(task.propertyId);
    if (upload.status !== "OPEN" || value.index >= manifest.parts.length || manifest.size > policy.evidence_max_bytes)
      throw new ReservationConflictError("upload_part_unavailable");
    const part = manifest.parts[value.index];
    if (bytes && (bytes.length !== part.size || createHash("sha256").update(bytes).digest("hex") !== part.sha256))
      throw new ReservationConflictError("upload_digest_mismatch");
    return fieldUploadPartStorageKey(ctx.organizationId, upload.id, value.index);
  });
  try { return await (deps.storage ?? new R2StorageProvider()).createSignedUploadUrl({ key, contentType: "application/octet-stream" }); }
  catch { throw new FieldUploadUnavailableError(); }
}

export async function storeFieldUploadPart(ctx: ReservationActorContext, input: unknown, bytes: Uint8Array, deps: UploadDeps = {}) {
  const signed = await signFieldUploadPart(ctx, input, deps, bytes);
  try {
    const response = await (deps.transport ?? fetch)(signed.url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new FieldUploadUnavailableError();
  } catch { throw new FieldUploadUnavailableError(); }
  return { stored: true };
}

export async function completeFieldUpload(ctx: ReservationActorContext, input: unknown, deps: CompleteUploadDeps = {}) {
  operationAllowed(ctx, "edit"); const value = completeRequestSchema.parse(input); checkOwner(ctx, value);
  const load = () => withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const uploads = new FieldUploadRepository(tx, ctx.organizationId), operations = new OperationRepository(tx, ctx.organizationId);
    const upload = await uploads.get(value.uploadId);
    if (!upload || upload.actorId !== ctx.actorId || upload.deviceId !== value.device_id) throw new ReservationNotFoundError();
    const task = await operations.task(upload.taskId); assigned(ctx, task);
    const manifest = fieldUploadManifestSchema.parse(upload.manifest), policy = await operations.policy(task.propertyId);
    if (upload.status === "CANCELLED" || manifest.size > policy.evidence_max_bytes) throw new ReservationConflictError("upload_unavailable");
    return { upload, manifest };
  });
  const initial = await load();
  if (initial.upload.status !== "OPEN") return { uploadId: initial.upload.id, status: initial.upload.status };
  const meta = await operationMeta(deps), storage = deps.storage ?? new R2StorageProvider(), transport = deps.transport ?? fetch;
  const bytes = new Uint8Array(initial.manifest.size);
  // Bounded parallel transport. No database transaction remains open during R2 I/O.
  for (let offset = 0; offset < initial.manifest.parts.length; offset += 4) {
    await Promise.all(initial.manifest.parts.slice(offset, offset + 4).map(async (part, relativeIndex) => {
      const index = offset + relativeIndex; let chunk: Uint8Array;
      try {
        const signed = await storage.createSignedDownloadUrl({ key: fieldUploadPartStorageKey(ctx.organizationId, initial.upload.id, index), expiresInSeconds: 60 });
        const response = await transport(signed.url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new FieldUploadUnavailableError();
        chunk = await readExactResponseBytes(response, part.size);
      } catch { throw new FieldUploadUnavailableError(); }
      if (createHash("sha256").update(chunk).digest("hex") !== part.sha256) throw new ReservationConflictError("upload_digest_mismatch");
      bytes.set(chunk, initial.manifest.parts.slice(0, index).reduce((size, item) => size + item.size, 0));
    }));
  }
  if (createHash("sha256").update(bytes).digest("hex") !== initial.manifest.sha256 || !validEvidenceImage(initial.manifest.contentType, bytes))
    throw new ReservationConflictError("operation_photo_invalid");
  try {
    const signed = await storage.createSignedUploadUrl({ key: `${ctx.organizationId}/tasks/${initial.upload.taskId}/${initial.manifest.localId}`, contentType: initial.manifest.contentType });
    const response = await transport(signed.url, { method: "PUT", headers: { "Content-Type": initial.manifest.contentType }, body: bytes, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new FieldUploadUnavailableError();
  } catch { throw new FieldUploadUnavailableError(); }
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const uploads = new FieldUploadRepository(tx, ctx.organizationId), operations = new OperationRepository(tx, ctx.organizationId);
    await operations.lock("crew-schedule"); await operations.lock(initial.upload.taskId); await uploads.lock(`${ctx.actorId}:${initial.manifest.localId}`);
    const upload = await uploads.get(initial.upload.id);
    if (!upload || upload.actorId !== ctx.actorId || upload.deviceId !== value.device_id) throw new ReservationNotFoundError();
    const task = await operations.task(upload.taskId); assigned(ctx, task);
    const policy = await operations.policy(task.propertyId);
    if (upload.status === "CANCELLED" || initial.manifest.size > policy.evidence_max_bytes) throw new ReservationConflictError("upload_unavailable");
    if (upload.status !== "OPEN") return { uploadId: upload.id, status: upload.status };
    await uploads.ready(upload.id, deps.now ?? new Date());
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "task.photo.upload.ready", resourceType: "task",
      resourceId: task.id, propertyScopeId: task.propertyId, before: { uploadId: upload.id, status: "OPEN" },
      after: { uploadId: upload.id, status: "READY", sha256: initial.manifest.sha256, size: initial.manifest.size },
      reason: initial.manifest.note, ...meta, occurredAt: deps.now ?? new Date() });
    return { uploadId: upload.id, status: "READY" as const };
  });
}

export async function attachFieldUploadEvidenceInTransaction(
  ctx: ReservationActorContext,
  value: { taskId: string; uploadId: string; deviceId: string; idempotencyKey: string },
  tx: TenantTransaction,
  meta: Awaited<ReturnType<typeof operationMeta>>,
) {
  const uploads = new FieldUploadRepository(tx, ctx.organizationId), operations = new OperationRepository(tx, ctx.organizationId);
  // Sync already holds all task locks before its actor lock; never acquire the
  // crew-schedule lock here, which would invert native assignment's lock order.
  const initial = await uploads.get(value.uploadId);
  if (!initial || initial.taskId !== value.taskId || initial.actorId !== ctx.actorId || initial.deviceId !== value.deviceId) throw new ReservationNotFoundError();
  await uploads.lock(`${ctx.actorId}:${initial.localId}`);
  const upload = await uploads.get(initial.id);
  if (!upload) throw new ReservationNotFoundError();
  const task = await operations.task(value.taskId); assigned(ctx, task);
  const manifest = fieldUploadManifestSchema.parse(upload.manifest), policy = await operations.policy(task.propertyId);
  if (manifest.size > policy.evidence_max_bytes || !["READY", "ATTACHED"].includes(upload.status)) throw new ReservationConflictError("upload_not_ready");
  if (upload.status === "ATTACHED") return { id: upload.evidenceId!, idempotent: true };
  const result = await persistOperationEvidence(operations, ctx, meta, {
    taskId: task.id, idempotencyKey: value.idempotencyKey, note: manifest.note, contentType: manifest.contentType
  }, { storageKey: `${ctx.organizationId}/tasks/${task.id}/${manifest.localId}`, size: manifest.size, sha256: manifest.sha256 });
  if (!result.id) throw new ReservationConflictError("upload_evidence_unavailable");
  if ((await uploads.attach(upload.id, result.id, new Date())).count !== 1) throw new ReservationConflictError("upload_evidence_unavailable");
  return result;
}
