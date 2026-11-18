import { Prisma } from "@prisma/client";
import { advisoryTransactionLock } from "@/platform/db/advisory-lock-repository";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { ScheduledChannels, ScheduledReportKind, ScheduledReportTarget } from "../domain/scheduled-report";

type Occurrence = { scheduleId: string; recipientId: string; scheduledOn: string };
type Run = Occurrence & {
  ruleId: string; propertyId: string | null; kind: ScheduledReportKind; fromOn: string; toOn: string;
  currency: string; fingerprint: string; generatedAt: Date; filters: unknown; channels: ScheduledChannels;
};

export class ScheduledReportRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  lock(input: Occurrence) {
    const key = [this.organizationId, "report", input.scheduleId, input.recipientId, input.scheduledOn].join(":");
    return advisoryTransactionLock(this.tx, key);
  }

  async exists(input: Occurrence) {
    const [row] = await this.tx.$queryRaw<{ exists: boolean }[]>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM report_run WHERE organization_id=${this.organizationId}::uuid
        AND schedule_id=${input.scheduleId}::uuid AND recipient_id=${input.recipientId}::uuid AND scheduled_on=${input.scheduledOn}::date)`);
    return row.exists;
  }

  async append(run: Run) {
    const [row] = await this.tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO report_run(organization_id,config_rule_id,schedule_id,recipient_id,property_id,report_kind,scheduled_on,
        from_on,to_on,currency,filters,channels,source_fingerprint,generated_at)
      VALUES(${this.organizationId}::uuid,${run.ruleId}::uuid,${run.scheduleId}::uuid,${run.recipientId}::uuid,${run.propertyId}::uuid,
        ${run.kind},${run.scheduledOn}::date,${run.fromOn}::date,${run.toOn}::date,${run.currency},${JSON.stringify(run.filters)}::jsonb,
        ARRAY[${Prisma.join(run.channels)}]::text[],${run.fingerprint},${run.generatedAt})
      ON CONFLICT (organization_id,schedule_id,recipient_id,scheduled_on) DO NOTHING
      RETURNING id`);
    return row?.id ?? null;
  }

  async targets(ids: string[], recipientId?: string) {
    if (!ids.length) return [];
    const rows = await this.tx.$queryRaw<Array<{
      id: string; propertyId: string | null; region: string | null; city: string | null; recipientId: string; scheduleId: string;
      kind: ScheduledReportKind; fromOn: string; toOn: string; currency: string; filters: unknown; channels: ScheduledChannels;
    }>>(Prisma.sql`
      SELECT r.id,r.schedule_id AS "scheduleId",r.property_id AS "propertyId",r.recipient_id AS "recipientId",p.city_id AS city,
        p.region_id AS region,r.report_kind AS kind,r.from_on::text AS "fromOn",r.to_on::text AS "toOn",r.currency,r.filters,r.channels
      FROM report_run r LEFT JOIN property p ON (p.organization_id,p.id)=(r.organization_id,r.property_id)
      WHERE r.organization_id=${this.organizationId}::uuid AND r.id=ANY(${ids}::uuid[])
        AND (${recipientId ?? null}::uuid IS NULL OR r.recipient_id=${recipientId ?? null}::uuid)`);
    return rows.map(({ id, propertyId, city, region, recipientId, kind, fromOn, toOn, currency, filters, channels, scheduleId }) => {
      const target: ScheduledReportTarget = { id, type: "report", organizationId: this.organizationId,
        propertyId, city, region, dataClass: "financial", reportRun: { recipientId, kind, fromOn, toOn, currency, filters } };
      return { id, target, channels, scheduleId };
    });
  }
}
