import type { Prisma } from "@prisma/client";
import type { AuditLogFilterInput } from "@/modules/audit/domain/audit";
import type { TenantTransaction } from "@/platform/db/tenant";

export type AuditRecordSummary = {
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

export type AuditRecordPage = {
  records: AuditRecordSummary[];
  total: number;
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function contains(value: string): Prisma.StringFilter<"AuditLog"> {
  return {
    contains: value,
    mode: "insensitive"
  };
}

function whereForFilters(
  organizationId: string,
  filters: AuditLogFilterInput
): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = { organizationId };

  if (filters.action) {
    where.action = contains(filters.action);
  }

  if (filters.resourceType) {
    where.resourceType = contains(filters.resourceType);
  }

  if (filters.requestId) {
    where.requestId = contains(filters.requestId);
  }

  if (filters.actorId && uuidPattern.test(filters.actorId)) {
    where.actorId = filters.actorId;
  }

  if (filters.from || filters.to) {
    where.occurredAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {})
    };
  }

  return where;
}

export class AuditRepository {
  constructor(
    private readonly tx: TenantTransaction,
    private readonly organizationId: string
  ) {}

  async list(filters: AuditLogFilterInput): Promise<AuditRecordPage> {
    const where = whereForFilters(this.organizationId, filters);
    const [total, records] = await Promise.all([
      this.tx.auditLog.count({ where }),
      this.tx.auditLog.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        take: filters.limit
      })
    ]);

    return { total, records };
  }
}

