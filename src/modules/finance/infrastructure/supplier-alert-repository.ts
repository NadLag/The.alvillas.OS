import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

type PriceChange = { id: string; supplierId: string; value: Prisma.JsonValue; previous: Prisma.JsonValue | null };
type ContractorAlert = { id: string; supplierId: string; taskId: string; propertyId: string; city: string | null; region: string | null;
  assignedAt: Date; responseDueAt: Date; completionDueAt: Date; completedAt: Date | null; status: string };

export class SupplierAlertRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}

  prices(asOf: Date, after?: string, references?: string[]) {
    if (references?.length === 0) return Promise.resolve([]);
    const page = after ? Prisma.sql`AND s.id > ${after}::uuid` : Prisma.empty;
    const filter = references ? Prisma.sql`AND current.id IN (${Prisma.join(references.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
    const limit = references ? references.length : 50;
    return this.tx.$queryRaw<PriceChange[]>(Prisma.sql`
      SELECT current.id,s.id AS "supplierId",current.value,previous.value AS previous FROM supplier s
      JOIN LATERAL (
        SELECT id,value,effective_from,version FROM config_rule r
        WHERE r.organization_id=s.organization_id AND r.key='finance.supplier_price_list.'||s.id::text
          AND r.scope_type='organization' AND r.scope_id IS NULL AND r.archived_at IS NULL AND r.lifecycle='ACTIVE'
          AND r.effective_from<=${asOf} AND (r.effective_to IS NULL OR r.effective_to>${asOf})
        ORDER BY r.effective_from DESC,r.version DESC LIMIT 1
      ) current ON TRUE
      LEFT JOIN LATERAL (
        SELECT r.value FROM config_rule r
        WHERE r.organization_id=s.organization_id AND r.key='finance.supplier_price_list.'||s.id::text
          AND r.scope_type='organization' AND r.scope_id IS NULL AND r.archived_at IS NULL AND r.lifecycle='ACTIVE'
          AND (r.effective_from,r.version)<(current.effective_from,current.version)
        ORDER BY r.effective_from DESC,r.version DESC LIMIT 1
      ) previous ON TRUE
      WHERE s.organization_id=${this.organizationId}::uuid AND s.archived_at IS NULL ${page} ${filter}
      ORDER BY s.id LIMIT ${limit}`);
  }

  contractors(asOf: Date, after?: string, references?: string[]) {
    if (references?.length === 0) return Promise.resolve([]);
    const page = after ? Prisma.sql`AND a.id > ${after}::uuid` : Prisma.empty;
    const filter = references ? Prisma.sql`AND a.id IN (${Prisma.join(references.map(id => Prisma.sql`${id}::uuid`))})` : Prisma.empty;
    const limit = references ? references.length : 50;
    const due = references ? Prisma.empty : Prisma.sql`AND a.response_due_at<${asOf}`;
    return this.tx.$queryRaw<ContractorAlert[]>(Prisma.sql`
      SELECT a.id,a.contractor_id AS "supplierId",t.id AS "taskId",p.id AS "propertyId",p.city_id AS city,p.region_id AS region,
        a.created_at AS "assignedAt",a.response_due_at AS "responseDueAt",a.completion_due_at AS "completionDueAt",
        t.completed_at AS "completedAt",t.state AS status
      FROM maintenance_contractor_assignment a
      JOIN supplier s ON s.organization_id=a.organization_id AND s.id=a.contractor_id AND s.archived_at IS NULL
      JOIN operation_task t ON t.organization_id=a.organization_id AND t.id=a.task_id AND t.archived_at IS NULL
      JOIN property p ON p.organization_id=t.organization_id AND p.id=t.property_id AND p.archived_at IS NULL
      WHERE a.organization_id=${this.organizationId}::uuid ${due} ${page} ${filter}
        AND NOT EXISTS (SELECT 1 FROM maintenance_contractor_assignment next
          WHERE next.organization_id=a.organization_id AND next.task_id=a.task_id AND next.revision>a.revision)
      ORDER BY a.id LIMIT ${limit}`);
  }

  async recorded(keys: string[]) {
    if (!keys.length) return new Set<string>();
    const existing = await this.tx.outboxEvent.findMany({ where: { organizationId: this.organizationId,
      type: "notification.requested", idempotencyKey: { in: keys } }, select: { idempotencyKey: true } });
    return new Set(existing.map(row => row.idempotencyKey));
  }
}
