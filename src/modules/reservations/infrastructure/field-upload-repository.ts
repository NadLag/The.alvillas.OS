import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { FieldUploadManifest } from "../domain/field-upload";
import type { FieldUploadLifecycleSnapshot } from "@/platform/config/field-upload-lifecycle-policy";

export class FieldUploadRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}
  async lock(key: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload:${this.organizationId}:${key}`},0))`);
  }
  byLocalId(actorId: string, localId: string) {
    return this.tx.operationEvidenceUpload.findFirst({ where: { organizationId: this.organizationId, actorId, localId } });
  }
  get(id: string) { return this.tx.operationEvidenceUpload.findFirst({ where: { organizationId: this.organizationId, id } }); }
  async reservePart(id: string, expiresAt: Date, generation = 1, activityAt = new Date()) {
    const upload = await this.get(id);
    if (!upload || upload.status !== "OPEN" || upload.generation !== generation) return false;
    const updated = await this.tx.operationEvidenceUpload.updateMany({
      where: { id: upload.id, organizationId: this.organizationId, status: "OPEN", generation },
      data: { partUploadExpiresAt: upload.partUploadExpiresAt && upload.partUploadExpiresAt > expiresAt ? upload.partUploadExpiresAt : expiresAt,
        lastActivityAt: upload.lastActivityAt > activityAt ? upload.lastActivityAt : activityAt }
    });
    return updated.count === 1;
  }
  lifecycleCandidates(limit: number) {
    return this.tx.operationEvidenceUpload.findMany({ where: { organizationId: this.organizationId, status: "OPEN" },
      include: { task: { select: { propertyId: true } } }, orderBy: [{ lifecycleCheckedAt: "asc" }, { id: "asc" }], take: limit });
  }
  lifecycleChecked(rows: readonly { id: string; generation: number }[], now: Date) {
    if (!rows.length) return Promise.resolve(0);
    return this.tx.$executeRaw(Prisma.sql`UPDATE operation_evidence_upload SET lifecycle_checked_at=${now}
      WHERE organization_id=${this.organizationId}::uuid AND status='OPEN' AND (id,generation) IN
      (${Prisma.join(rows.map(row => Prisma.sql`(${row.id}::uuid,${row.generation}::integer)`))})`);
  }
  touchOpen(id: string, generation: number, now: Date) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, generation, status: "OPEN", lastActivityAt: { lt: now } }, data: { lastActivityAt: now } });
  }
  expire(id: string, generation: number, lastActivityAt: Date, now: Date, policy: FieldUploadLifecycleSnapshot) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, generation, status: "OPEN", lastActivityAt,
      OR: [{ partUploadExpiresAt: null }, { partUploadExpiresAt: { lte: now } }] },
    data: { status: "CANCELLED", expiredAt: now, expiryPolicy: policy, lifecycleCheckedAt: now } });
  }
  recover(id: string, generation: number, now: Date) {
    if (generation >= 2_147_483_647) return Promise.resolve({ count: 0 });
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, generation, status: "CANCELLED",
      expiredAt: { not: null }, cleanedAt: { not: null }, evidenceId: null }, data: { status: "OPEN", generation: { increment: 1 },
      lastActivityAt: now, lifecycleCheckedAt: now, expiredAt: null, expiryPolicy: Prisma.DbNull,
      cleanedAt: null, partUploadExpiresAt: null, readyAt: null, attachedAt: null } });
  }
  cleanupCandidates(now: Date, legacyUntil: Date, limit: number) {
    return this.tx.operationEvidenceUpload.findMany({ where: { organizationId: this.organizationId, cleanedAt: null,
      status: { in: ["READY", "ATTACHED", "CANCELLED"] }, OR: [
        { partUploadExpiresAt: { lte: now } }, { partUploadExpiresAt: null, updatedAt: { lte: legacyUntil } }
      ] }, orderBy: [{ lifecycleCheckedAt: "asc" }, { id: "asc" }], take: limit });
  }
  cleanupAttempted(id: string, now: Date, generation = 1) {
    // Order retries strictly after pending work even when process clocks or
    // millisecond timestamps tie. Transport ordering never extends a PUT lease
    // or rewrites the closure time used by pre-lease cleanup protection.
    return this.tx.$executeRaw(Prisma.sql`UPDATE operation_evidence_upload
      SET lifecycle_checked_at=GREATEST(${now},COALESCE((SELECT MAX(lifecycle_checked_at)
        FROM operation_evidence_upload WHERE organization_id=${this.organizationId}::uuid
        AND status IN ('READY','ATTACHED','CANCELLED') AND cleaned_at IS NULL),${now})+INTERVAL '1 microsecond')
      WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid AND generation=${generation}
      AND cleaned_at IS NULL AND status IN ('READY','ATTACHED','CANCELLED')`);
  }
  create(actorId: string, deviceId: string, manifest: FieldUploadManifest, manifestHash: string, now = new Date()) {
    return this.tx.operationEvidenceUpload.create({ data: { organizationId: this.organizationId, actorId, deviceId,
      taskId: manifest.taskId, localId: manifest.localId, manifest, manifestHash, lastActivityAt: now, lifecycleCheckedAt: now } });
  }
  ready(id: string, now: Date, generation = 1) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, generation, status: "OPEN" },
      data: { status: "READY", readyAt: now } });
  }
  attach(id: string, evidenceId: string, now: Date) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, status: "READY", evidenceId: null },
      data: { status: "ATTACHED", evidenceId, attachedAt: now } });
  }
  cancel(id: string) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, status: { in: ["OPEN", "READY"] } }, data: { status: "CANCELLED" } });
  }
  cleaned(id: string, now: Date, generation = 1) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, generation, status: { in: ["READY", "ATTACHED", "CANCELLED"] }, cleanedAt: null }, data: { cleanedAt: now } });
  }
}
