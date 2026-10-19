import { createHash } from "node:crypto";
import { z } from "zod";
import { OperationRepository } from "../infrastructure/operation-repository";
import type { ReservationActorContext } from "./reservation-access";
import {
  operationAllowed,
  operationAudit,
  operationHash,
  operationMeta,
  taskResource,
  type OperationDeps,
} from "./operation-service";
import {
  ReservationAuthorizationError,
  ReservationConflictError,
  ReservationNotFoundError,
} from "./reservation-service";
import { authorize } from "@/platform/authz/authorize";
import { withTenant } from "@/platform/db/tenant";
import { prisma } from "@/platform/db/client";
import { R2StorageProvider } from "@/platform/providers/real";
import type { StorageProvider } from "@/platform/providers";
import {
  evidenceInputSchema,
  issueInputSchema,
  progressInputSchema,
} from "../domain/operation-task";
type EvidenceDeps = OperationDeps & {
  storage?: StorageProvider & {
    createSignedDownloadUrl(input: {
      key: string;
      expiresInSeconds: number;
    }): Promise<{ url: string }>;
  };
  transport?: typeof fetch;
};
const evidenceSchema = evidenceInputSchema;
export const issueSchema = issueInputSchema;
export async function saveOperationProgress(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "edit");
  const value = progressInputSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "edit", taskResource(task));
    if (
      task.assignedToUserAccountId !== ctx.actorId ||
      task.assignedToPersonId !== ctx.personId ||
      !["ASSIGNED", "IN_PROGRESS"].includes(task.state)
    )
      throw new ReservationConflictError();
    const ids = new Set(value.checklistItemIds);
    if (
      ids.size !== value.checklistItemIds.length ||
      value.checklistItemIds.some(
        (id) => !task.checklistItems.some((i) => i.id === id),
      )
    )
      throw new ReservationConflictError();
    const hash = operationHash({ operation: "progress", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.createdBy !== ctx.actorId || receipt.payloadHash !== hash)
        throw new ReservationConflictError();
      return task;
    }
    await repo.checklistProgress(task.id, [...ids], ctx.actorId, ctx.personId);
    await repo.context(
      ctx.actorId,
      meta.requestId,
      "Save assigned checklist progress",
    );
    await repo.update(task.id, {
      state: ids.size ? "IN_PROGRESS" : task.state,
    });
    await repo.record(task.id, value.idempotencyKey, hash, ctx.actorId);
    const after = (await repo.task(task.id))!;
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.checklist.progress",
      after,
      task,
      "Save assigned checklist progress",
    );
    return after;
  });
}
export function validEvidenceImage(type: string, bytes: Uint8Array) {
  return type === "image/png"
    ? Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    : type === "image/jpeg" &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255;
}
export async function attachOperationEvidence(
  ctx: ReservationActorContext,
  input: unknown,
  bytes?: Uint8Array,
  deps: EvidenceDeps = {},
) {
  operationAllowed(ctx, "edit");
  const value = evidenceSchema.parse(input),
    meta = await operationMeta(deps);
  if (
    Boolean(value.contentType) !== Boolean(bytes?.length) ||
    (bytes && !validEvidenceImage(value.contentType!, bytes))
  )
    throw new ReservationConflictError("operation_photo_invalid");
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock("crew-schedule");
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "edit", taskResource(task));
    const settings = await repo.policy(task.propertyId);
    if (bytes && bytes.length > settings.evidence_max_bytes)
      throw new ReservationConflictError("operation_photo_too_large");
    const digest = bytes
        ? createHash("sha256").update(bytes).digest("hex")
        : null,
      hash = operationHash({ operation: "evidence", value, digest }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      return { id: receipt.resultResourceId ?? undefined, idempotent: true };
    }
    let storageKey: string | null = null;
    if (bytes) {
      storageKey = `${ctx.organizationId}/tasks/${task.id}/${value.idempotencyKey}`;
      const storage = deps.storage ?? new R2StorageProvider(),
        signed = await storage.createSignedUploadUrl({
          key: storageKey,
          contentType: value.contentType!,
        });
      const response = await (deps.transport ?? fetch)(signed.url, {
        method: "PUT",
        headers: { "Content-Type": value.contentType! },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new ReservationConflictError("operation_storage_unavailable");
    }
    const evidence = await repo.addEvidence({
      taskId: task.id,
      note: value.note,
      contentType: value.contentType,
      storageKey,
      size: bytes?.length,
      sha256: digest,
      createdBy: ctx.actorId,
    });
    await repo.context(ctx.actorId, meta.requestId, value.note);
    await repo.update(task.id, { updatedAt: new Date() });
    await repo.record(
      task.id,
      value.idempotencyKey,
      hash,
      ctx.actorId,
      evidence.id,
    );
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.evidence.attached",
      (await repo.task(task.id))!,
      { evidenceId: evidence.id },
      value.note,
    );
    return { id: evidence.id, idempotent: false };
  });
}
export async function taskEvidence(
  ctx: ReservationActorContext,
  taskId: string,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  z.uuid().parse(taskId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      task = await repo.task(taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "view", taskResource(task));
    return {
      evidence: (await repo.evidence(taskId)).map(
        ({ id, note, contentType, createdAt, createdBy }) => ({
          id,
          note,
          contentType,
          createdAt,
          createdBy,
        }),
      ),
      issues: await repo.issues(taskId),
    };
  });
}
export async function downloadOperationEvidence(
  ctx: ReservationActorContext,
  id: string,
  deps: EvidenceDeps = {},
) {
  operationAllowed(ctx, "view");
  z.uuid().parse(id);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId),
      evidence = await repo.evidenceById(id);
    if (!evidence?.storageKey || !evidence.contentType || !evidence.size)
      throw new ReservationNotFoundError();
    const task = await repo.task(evidence.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "view", taskResource(task));
    const policy = await repo.policy(task.propertyId),
      storage = deps.storage ?? new R2StorageProvider(),
      signed = await storage.createSignedDownloadUrl({
        key: evidence.storageKey,
        expiresInSeconds: policy.evidence_link_seconds,
      });
    const response = await (deps.transport ?? fetch)(signed.url, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body) throw new ReservationConflictError();
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > evidence.size) throw new ReservationConflictError();
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    if (
      size !== evidence.size ||
      createHash("sha256").update(bytes).digest("hex") !== evidence.sha256 ||
      !validEvidenceImage(evidence.contentType, bytes)
    )
      throw new ReservationConflictError();
    return { bytes: new Uint8Array(bytes), contentType: evidence.contentType };
  });
}
export async function reportOperationIssue(
  ctx: ReservationActorContext,
  input: unknown,
  deps: OperationDeps = {},
) {
  operationAllowed(ctx, "view");
  const value = issueSchema.parse(input),
    meta = await operationMeta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new OperationRepository(tx, ctx.organizationId);
    await repo.lock(value.taskId);
    await repo.lock(value.idempotencyKey);
    const task = await repo.task(value.taskId);
    if (!task) throw new ReservationNotFoundError();
    operationAllowed(ctx, "view", taskResource(task));
    if (
      !authorize(ctx.authContext, "create", {
        ...taskResource(task),
        type: "issue",
      })
    )
      throw new ReservationAuthorizationError();
    const hash = operationHash({ operation: "issue", value }),
      receipt = await repo.receipt(value.idempotencyKey);
    if (receipt) {
      if (receipt.payloadHash !== hash || receipt.createdBy !== ctx.actorId)
        throw new ReservationConflictError();
      if (!receipt.resultResourceId) throw new ReservationConflictError();
      return receipt.resultResourceId;
    }
    const issue = await repo.addIssue({
      ...value,
      propertyId: task.propertyId,
      createdBy: ctx.actorId,
    });
    await repo.record(
      task.id,
      value.idempotencyKey,
      hash,
      ctx.actorId,
      issue.id,
    );
    await repo.context(ctx.actorId, meta.requestId, value.description);
    await repo.update(task.id, { updatedAt: new Date() });
    await operationAudit(
      repo,
      ctx,
      meta,
      "task.issue.reported",
      (await repo.task(task.id))!,
      { issueId: issue.id },
      value.description,
    );
    await repo.event(
      "IssueReported",
      task.id,
      task.propertyId,
      `issue:${issue.id}:reported`,
    );
    return issue.id;
  });
}
