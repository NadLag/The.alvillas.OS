import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { Resource } from "@/platform/authz/authorize";
import { calendarDateStart } from "@/platform/time/calendar";
import { Money } from "@/platform/money/money";

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
  async ledgerAccountResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.ledgerAccount.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true }
    });
    return new Map(rows.map(row => [row.id, {
      type: "financial_transaction", organizationId: this.organizationId, id: row.id,
      financialRecordId: row.id, dataClass: "financial"
    }]));
  }
  async transactionGroupResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.transactionGroup.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true } });
    return new Map(rows.map(row => [row.id, { type: "financial_transaction", organizationId: this.organizationId, id: row.id, dataClass: "financial" }]));
  }
  async transactionResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.financialTransaction.findMany({
      where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, createdBy: true, occurredAt: true,
        postings: { select: { side: true, amount: true, currency: true, dimensions: true } } }
    });
    return new Map(rows.map(row => {
      const totals = new Map<string, Money>();
      for (const line of row.postings) if (line.side === "DEBIT") {
        const amount = Money.of(line.amount.toString(), line.currency);
        totals.set(line.currency, (totals.get(line.currency) ?? Money.zero(line.currency)).add(amount));
      }
      const dimension = (key: string) => {
        const ids = new Set(row.postings.flatMap(line => {
          const value = line.dimensions && typeof line.dimensions === "object" && !Array.isArray(line.dimensions)
            ? line.dimensions[key] : null;
          return typeof value === "string" && uuidPattern.test(value) ? [value] : [];
        }));
        return ids.size === 1 ? [...ids][0] : undefined;
      };
      // Different currencies cannot be compared with one grant amount limit.
      return [row.id, {
        type: "financial_transaction", organizationId: this.organizationId, id: row.id, financialRecordId: row.id,
        assignedUserAccountId: row.createdBy, occurredAt: row.occurredAt, status: "POSTED",
        propertyId: dimension("property_id"), ownerId: dimension("owner_id"), reservationId: dimension("reservation_id"),
        amount: totals.size === 1 ? [...totals.values()][0].amount.toString() : undefined, dataClass: "financial"
      }];
    }));
  }
  async expenseResources(ids: string[]): Promise<Map<string, Resource>> {
    if (!ids.length) return new Map();
    const rows = await this.tx.expense.findMany({ where: { organizationId: this.organizationId, id: { in: ids } },
      select: { id: true, propertyId: true, reservationId: true, amount: true, state: true, createdBy: true, occurredOn: true,
        property: { select: { city: true, cityId: true, region: true, regionId: true, timezone: true } } } });
    return new Map(rows.map(row => [row.id, { type: "expense", organizationId: this.organizationId, id: row.id, financialRecordId: row.id,
      propertyId: row.propertyId, reservationId: row.reservationId, amount: row.amount.toString(), occurredAt: calendarDateStart(row.occurredOn.toISOString().slice(0,10), row.property.timezone),
      assignedUserAccountId: row.createdBy, city: row.property.cityId ?? row.property.city, region: row.property.regionId ?? row.property.region,
      status: row.state, dataClass: "financial" }]));
  }
}
