import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { KpiMaterializationPeriod } from "../domain/kpi-materialization";
import type { PortfolioNights } from "../domain/performance-report";

type Period = { fromOn: string; toOn: string; timezone: string };
type Input = Period & { key: KpiMaterializationPeriod; ruleId: string; observedAt: Date; sourceRevision: bigint };
const integer = z.string().regex(/^\d+$/u);
const portfolioSchema = z.array(z.strictObject({
  propertyId: z.uuid(), propertyName: z.string(), available: integer, occupied: integer, blocked: integer, conflicts: integer
}));

export class KpiMaterializationRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  async revision() {
    const [row] = await this.tx.$queryRaw<{ revision: bigint }[]>(Prisma.sql`
      SELECT revision FROM report_calendar_source_revision WHERE organization_id=${this.organizationId}::uuid`);
    return row?.revision ?? 0n;
  }

  async fresh(input: Input, minimumComputedAt: Date) {
    const [row] = await this.tx.$queryRaw<{ fresh: boolean }[]>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM report_calendar_materialization
        WHERE organization_id=${this.organizationId}::uuid AND period_key=${input.key}
          AND from_on=${input.fromOn}::date AND to_on=${input.toOn}::date AND timezone=${input.timezone}
          AND source_revision=${input.sourceRevision} AND config_rule_id=${input.ruleId}::uuid
          AND computed_at>=${minimumComputedAt}) AS fresh`);
    return row.fresh;
  }

  async lookup({ fromOn, toOn, timezone }: Period) {
    // Match both the native revision and the exact requested range in one statement.
    const [row] = await this.tx.$queryRaw<{ rows: unknown }[]>(Prisma.sql`
      SELECT cache.rows FROM report_calendar_materialization cache
      LEFT JOIN report_calendar_source_revision revision ON revision.organization_id=cache.organization_id
      WHERE cache.organization_id=${this.organizationId}::uuid AND cache.timezone=${timezone}
        AND cache.from_on=${fromOn}::date AND cache.to_on=${toOn}::date
        AND cache.source_revision=coalesce(revision.revision,0)
      ORDER BY cache.computed_at DESC,cache.period_key LIMIT 1`);
    const validated = portfolioSchema.safeParse(row?.rows);
    return validated.success ? validated.data : null;
  }

  async publish(input: Input, rows: PortfolioNights[]) {
    const values = JSON.stringify(portfolioSchema.parse(rows));
    return this.tx.$executeRaw(Prisma.sql`
      INSERT INTO report_calendar_materialization(organization_id,period_key,from_on,to_on,timezone,source_revision,config_rule_id,rows,computed_at)
      VALUES(${this.organizationId}::uuid,${input.key},${input.fromOn}::date,${input.toOn}::date,${input.timezone},${input.sourceRevision},${input.ruleId}::uuid,${values}::jsonb,${input.observedAt})
      ON CONFLICT(organization_id,period_key) DO UPDATE SET
        from_on=excluded.from_on,to_on=excluded.to_on,timezone=excluded.timezone,source_revision=excluded.source_revision,
        config_rule_id=excluded.config_rule_id,rows=excluded.rows,computed_at=excluded.computed_at
      WHERE report_calendar_materialization.source_revision<=excluded.source_revision
        AND report_calendar_materialization.computed_at<=excluded.computed_at`);
  }
}
