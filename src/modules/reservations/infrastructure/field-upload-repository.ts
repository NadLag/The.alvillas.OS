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
