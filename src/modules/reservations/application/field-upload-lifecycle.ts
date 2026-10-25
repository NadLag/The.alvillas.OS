import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { fieldUploadLifecycleKey, fieldUploadLifecycleSnapshot } from "@/platform/config/field-upload-lifecycle-policy";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { FieldUploadRepository } from "../infrastructure/field-upload-repository";
import { OperationRepository } from "../infrastructure/operation-repository";

type LifecycleDeps = { db?: TenantTransactionRunner; now?: Date; limit?: number };

/** Tenant-bound transport maintenance under an explicitly configured policy. */
export async function expireInactiveFieldUploads(organizationId: string, deps: LifecycleDeps = {}) {
  const db = deps.db ?? prisma, now = deps.now ?? new Date(), limit = deps.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(now.getTime())) throw Error("Invalid upload lifecycle batch");
  const candidates = await withTenant(db, organizationId, async tx => {
    const repository = new FieldUploadRepository(tx, organizationId), rows = await repository.lifecycleCandidates(limit);
    if (!rows.length) return [];
    const scopes = await new ReservationConfigScopeRepository(tx, organizationId).propertyScopes([...new Set(rows.map(row => row.task.propertyId))], now);
    const policies = await new ConfigRuleRepository(tx, organizationId).resolveScopeGroups(fieldUploadLifecycleKey, scopes, now);
    await repository.lifecycleChecked(rows, now);
    return rows.flatMap(row => {
      const policy = fieldUploadLifecycleSnapshot(policies.get(row.task.propertyId) ?? null);
      return policy?.openUploadIdleAfterMinutes !== null && policy?.openUploadIdleAfterMinutes !== undefined ? [{ row, policy }] : [];
    });
  });
  let expired = 0;
  for (const { row: candidate, policy } of candidates) {
    expired += await withTenant(db, organizationId, async tx => {
      const operations = new OperationRepository(tx, organizationId), uploads = new FieldUploadRepository(tx, organizationId);
      await operations.lock("crew-schedule"); await operations.lock(candidate.taskId); await uploads.lock(`${candidate.actorId}:${candidate.localId}`);
      const upload = await uploads.get(candidate.id);
      if (!upload || upload.status !== "OPEN" || upload.generation !== candidate.generation ||
        now.getTime() - upload.lastActivityAt.getTime() < policy.openUploadIdleAfterMinutes! * 60_000 ||
        (upload.partUploadExpiresAt && upload.partUploadExpiresAt > now)) return 0;
      if ((await uploads.expire(upload.id, upload.generation, upload.lastActivityAt, now, policy)).count !== 1) return 0;
      await writeAuditEvent(tx, { organizationId, actorId: null, action: "task.photo.upload.expired", resourceType: "task", resourceId: upload.taskId,
        propertyScopeId: candidate.task.propertyId, deviceId: upload.deviceId, requestId: `field-upload-expiry:${upload.id}:${upload.generation}`,
        reason: fieldUploadLifecycleKey, before: { uploadId: upload.id, generation: upload.generation, status: upload.status,
          lastActivityAt: upload.lastActivityAt, partUploadExpiresAt: upload.partUploadExpiresAt },
        after: { uploadId: upload.id, generation: upload.generation, status: "CANCELLED", expiredAt: now, policy }, occurredAt: now });
      return 1;
    });
  }
  return { expired };
}
