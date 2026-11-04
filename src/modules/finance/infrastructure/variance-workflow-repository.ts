import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { VarianceSourceReference } from "../domain/variance-workflow";

export type NativeVarianceWorkflowSource = {
  fingerprint: string; state: "OPEN" | "MATCHED" | "SOURCE_CHANGED"; createdAt: Date;
  sourceAuditId: string | null; reason: string | null; action: string | null;
};

export class VarianceWorkflowRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async lockActor(actorId: string, nonce: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":variance-workflow-actor:" + actorId + ":" + nonce},0))::text`);
  }
  async lockSource(source: VarianceSourceReference) {
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":variance-workflow-source:" + source.provider + ":" + source.id},0))::text`);
  }
  async source(source: VarianceSourceReference) {
    const rows = await this.tx.$queryRaw<NativeVarianceWorkflowSource[]>(Prisma.sql`
      SELECT native_source.fingerprint,native_source.state,native_source.created_at AS "createdAt",
        native_source.source_audit_id AS "sourceAuditId",native_source.original_reason AS reason,native_source.original_action AS action
      FROM app_variance_workflow_source(${this.organizationId}::uuid,${source.provider}::text,${source.id}::uuid) native_source`);
    return rows[0] ?? null;
  }
  latest(source: VarianceSourceReference) {
    return this.tx.varianceWorkflowEvent.findFirst({ where: { organizationId: this.organizationId, provider: source.provider, sourceId: source.id }, orderBy: { version: "desc" } });
  }
  history(source: VarianceSourceReference, before?: bigint) {
    return this.tx.varianceWorkflowEvent.findMany({ where: { organizationId: this.organizationId, provider: source.provider, sourceId: source.id,
      ...(before === undefined ? {} : { version: { lt: before } }) }, orderBy: { version: "desc" }, take: 51 });
  }
  byActorNonce(actorId: string, idempotencyKey: string) {
    return this.tx.varianceWorkflowEvent.findFirst({ where: { organizationId: this.organizationId, actorId, idempotencyKey } });
  }
  async intentHash(intent: Prisma.InputJsonValue) {
    const [row] = await this.tx.$queryRaw<Array<{ hash: string }>>(Prisma.sql`
      SELECT encode(digest(convert_to(${JSON.stringify(intent)}::jsonb::text,'UTF8'),'sha256'),'hex') AS hash`);
    return row.hash;
  }
  eligibleAssignee(id: string) {
    return this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id, status: "ACTIVE", person: { archivedAt: null } }, select: { id: true } });
  }
  assignees(before?: string) {
    return this.tx.userAccount.findMany({ where: { organizationId: this.organizationId, status: "ACTIVE", person: { archivedAt: null },
      ...(before ? { id: { gt: before } } : {}) }, select: { id: true, personId: true, person: { select: { id: true, displayName: true } } }, orderBy: { id: "asc" }, take: 51 });
  }
  originalVariance(id: string) {
    return this.tx.variance.findFirst({ where: { organizationId: this.organizationId, id, sourceType: "AIRBNB_SETTLEMENT" } });
  }
  originalBankEntry(id: string) {
    return this.tx.bankReconciliationEntry.findFirst({ where: { organizationId: this.organizationId, id, action: "MATCH" }, include: { allocations: true, evidence: true } });
  }
  originalClaim(id: string) {
    return this.tx.employeeCompensationClaim.findFirst({ where: { organizationId: this.organizationId, id } });
  }
  originalStocktake(id: string) {
    return this.tx.inventoryStocktake.findFirst({ where: { organizationId: this.organizationId, id }, include: { movement: true, item: true, task: true, property: true } });
  }
  create(data: Prisma.VarianceWorkflowEventCreateManyInput) {
    return this.tx.varianceWorkflowEvent.create({ data });
  }
  async flushGuards() { await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE"); }
}
