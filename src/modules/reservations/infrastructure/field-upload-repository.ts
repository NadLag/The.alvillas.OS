import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { FieldUploadManifest } from "../domain/field-upload";

export class FieldUploadRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}
  async lock(key: string) {
    await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload:${this.organizationId}:${key}`},0))`);
  }
  byLocalId(actorId: string, localId: string) {
    return this.tx.operationEvidenceUpload.findFirst({ where: { organizationId: this.organizationId, actorId, localId } });
  }
  get(id: string) { return this.tx.operationEvidenceUpload.findFirst({ where: { organizationId: this.organizationId, id } }); }
  async reservePart(id: string, expiresAt: Date) {
    const upload = await this.get(id);
    if (!upload || upload.status !== "OPEN") return false;
    if (!upload.partUploadExpiresAt || upload.partUploadExpiresAt < expiresAt) await this.tx.operationEvidenceUpload.update({
      where: { id: upload.id, organizationId: this.organizationId }, data: { partUploadExpiresAt: expiresAt }
    });
    return true;
  }
  cleanupCandidates(now: Date, legacyUntil: Date, limit: number) {
    return this.tx.operationEvidenceUpload.findMany({ where: { organizationId: this.organizationId, cleanedAt: null,
      status: { in: ["READY", "ATTACHED", "CANCELLED"] }, OR: [
        { partUploadExpiresAt: { lte: now } }, { partUploadExpiresAt: null, updatedAt: { lte: legacyUntil } }
      ] }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: limit });
  }
  cleanupAttempted(id: string, now: Date) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, cleanedAt: null,
      status: { in: ["READY", "ATTACHED", "CANCELLED"] } }, data: { updatedAt: now } });
  }
  create(actorId: string, deviceId: string, manifest: FieldUploadManifest, manifestHash: string) {
    return this.tx.operationEvidenceUpload.create({ data: { organizationId: this.organizationId, actorId, deviceId,
      taskId: manifest.taskId, localId: manifest.localId, manifest, manifestHash } });
  }
  ready(id: string, now: Date) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, status: "OPEN" },
      data: { status: "READY", readyAt: now } });
  }
  attach(id: string, evidenceId: string, now: Date) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, status: "READY", evidenceId: null },
      data: { status: "ATTACHED", evidenceId, attachedAt: now } });
  }
  cancel(id: string) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, status: { in: ["OPEN", "READY"] } }, data: { status: "CANCELLED" } });
  }
  cleaned(id: string, now: Date) {
    return this.tx.operationEvidenceUpload.updateMany({ where: { organizationId: this.organizationId, id, status: { in: ["READY", "ATTACHED", "CANCELLED"] }, cleanedAt: null }, data: { cleanedAt: now } });
  }
}
