import { Prisma } from "@prisma/client";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

export class RecurringPayoutDraftRepository {
  constructor(readonly tx: TenantTransaction, readonly organizationId: string) {}
  runner(): TenantTransactionRunner { return { $transaction: async work => work(this.tx) }; }
  async lock() { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":recurring-payout-drafts"},0))::text`); }
  find(targetId: string, slot: string) { return this.tx.recurringPayoutDraftOccurrence.findUnique({ where: { organizationId_targetId_slot: { organizationId: this.organizationId, targetId, slot } } }); }
  properties(ids: string[]) { return this.tx.property.findMany({ where: { organizationId: this.organizationId, id: { in: [...new Set(ids)] } }, select: { id: true, timezone: true, archivedAt: true } }); }
  async issued(slots: Array<{ targetId: string; slot: string }>) {
    if (!slots.length) return new Set<string>();
    const rows = await this.tx.$queryRaw<Array<{ targetId: string }>>(Prisma.sql`SELECT o.target_id::text AS "targetId"
      FROM recurring_payout_draft_occurrence o JOIN jsonb_to_recordset(${JSON.stringify(slots)}::jsonb) desired("targetId" uuid,slot text)
      ON o.target_id=desired."targetId" AND o.slot=desired.slot WHERE o.organization_id=${this.organizationId}::uuid`);
    return new Set(rows.map(row => row.targetId));
  }
  create(input: { targetId: string; slot: string; configRuleId: string; payoutId: string; scheduledAt: Date; timezone: string; createdBy: string; createdAt: Date; evidence: Prisma.InputJsonObject }) {
    return this.tx.recurringPayoutDraftOccurrence.create({ data: { organizationId: this.organizationId, ...input } });
  }
  async lockSources(configRuleId: string, ownerId: string, propertyId: string, methodId: string) {
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM config_rule WHERE organization_id=${this.organizationId}::uuid AND id=${configRuleId}::uuid FOR SHARE`);
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM owner WHERE organization_id=${this.organizationId}::uuid AND id=${ownerId}::uuid FOR SHARE`);
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM property WHERE organization_id=${this.organizationId}::uuid AND id=${propertyId}::uuid FOR SHARE`);
    await this.tx.$queryRaw(Prisma.sql`SELECT id FROM owner_payout_method WHERE organization_id=${this.organizationId}::uuid AND id=${methodId}::uuid FOR SHARE`);
  }
}
