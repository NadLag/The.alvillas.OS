import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";

export type AuditHistoryFilters = {
  action?: string;
  resourceType?: string;
  actorId?: string;
  resourceId?: string;
  propertyScopeId?: string;
  from?: Date;
  to?: Date;
};

export type AuditHistoryRow = {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress: string | null;
  deviceId: string | null;
  propertyScopeId: string | null;
  before: Prisma.JsonValue | null;
  after: Prisma.JsonValue | null;
  reason: string | null;
  requestId: string;
  occurredAt: Date;
  createdAt: Date;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function uuidFilter(value: string | undefined): string | undefined {
  return value && uuidPattern.test(value) ? value : undefined;
}

function whereFor(organizationId: string, filters: AuditHistoryFilters): Prisma.AuditLogWhereInput {
  return {
    organizationId,
    ...(filters.action
      ? { action: { contains: filters.action, mode: "insensitive" as const } }
      : {}),
    ...(filters.resourceType
      ? { resourceType: { contains: filters.resourceType, mode: "insensitive" as const } }
      : {}),
    ...(uuidFilter(filters.actorId) ? { actorId: uuidFilter(filters.actorId) } : {}),
    ...(uuidFilter(filters.resourceId) ? { resourceId: uuidFilter(filters.resourceId) } : {}),
    ...(uuidFilter(filters.propertyScopeId)
      ? { propertyScopeId: uuidFilter(filters.propertyScopeId) }
      : {}),
    ...(filters.from || filters.to
      ? {
          occurredAt: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {})
          }
        }
      : {})
  };
}

export class AuditRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async list(filters: AuditHistoryFilters, limit: number): Promise<AuditHistoryRow[]> {
    return this.tx.auditLog.findMany({
      where: whereFor(this.organizationId, filters),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit
    });
  }

  async count(filters: AuditHistoryFilters): Promise<number> {
    return this.tx.auditLog.count({
      where: whereFor(this.organizationId, filters)
    });
  }
  async cashResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.cashCollection.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, taskId: true, propertyId: true, reservationId: true, transactionId: true, collectorUserAccountId: true, collectorPersonId: true, amount: true,
        task: { select: { state: true } }, property: { select: { city: true, cityId: true, region: true, regionId: true } } } });
    return new Map(rows.map(row => [row.id, { type: "cash_collection", organizationId: this.organizationId, id: row.id,
      financialRecordId: row.transactionId, propertyId: row.propertyId, reservationId: row.reservationId, taskId: row.taskId, jobId: row.taskId,
      assignedUserAccountId: row.collectorUserAccountId, assignedPersonId: row.collectorPersonId, amount: row.amount.toString(),
      city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region, status: row.task.state, dataClass: "financial" }]));
  }
}
