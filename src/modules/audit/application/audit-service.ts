import { z } from "zod";
import {
  AuditRepository,
  type AuditHistoryFilters,
  type AuditHistoryRow
} from "@/modules/audit/infrastructure/audit-repository";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type Action } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

export const auditLogResource = "audit_log";

export class AuditAuthorizationError extends Error {
  constructor(message = "Audit history action is not authorized") {
    super(message);
    this.name = "AuditAuthorizationError";
  }
}

type AuditServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

export type AuditHistoryResult = {
  rows: AuditHistoryRow[];
  total: number;
  limit: number;
};

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional();

const dateFilter = optionalTrimmedString.transform((value, ctx) => {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: "custom", message: "Invalid date" });
    return z.NEVER;
  }

  return date;
});

export const auditFilterSchema = z.object({
  action: optionalTrimmedString,
  resourceType: optionalTrimmedString,
  actorId: optionalTrimmedString,
  resourceId: optionalTrimmedString,
  propertyScopeId: optionalTrimmedString,
  from: dateFilter,
  to: dateFilter
});

export type AuditFilterInput = z.input<typeof auditFilterSchema>;

function db(deps: AuditServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function assertAllowed(ctx: AuditActorContext, action: Action): void {
  const allowed = authorize(ctx.authContext, action, {
    type: auditLogResource,
    organizationId: ctx.organizationId
  });

  if (!allowed) {
    throw new AuditAuthorizationError();
  }
}

export function parseAuditFilters(input: AuditFilterInput): AuditHistoryFilters {
  return auditFilterSchema.parse(input);
}

export async function listAuditHistory(
  ctx: AuditActorContext,
  filters: AuditHistoryFilters,
  deps: AuditServiceDeps = {}
): Promise<AuditHistoryResult> {
  assertAllowed(ctx, "view");
  const limit = 100;

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new AuditRepository(tx, ctx.organizationId);
    const [rows, total] = await Promise.all([
      repository.list(filters, limit),
      repository.count(filters)
    ]);

    return { rows, total, limit };
  });
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" || typeof value === "bigint"
          ? String(value)
          : JSON.stringify(value);

  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function auditPayloadCell(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value);
}

export function auditHistoryCsv(rows: readonly AuditHistoryRow[]): string {
  const header = [
    "occurred_at",
    "actor_id",
    "action",
    "resource_type",
    "resource_id",
    "property_scope_id",
    "ip_address",
    "device_id",
    "reason",
    "request_id",
    "before",
    "after"
  ];
  const body = rows.map((row) =>
    [
      row.occurredAt,
      row.actorId,
      row.action,
      row.resourceType,
      row.resourceId,
      row.propertyScopeId,
      row.ipAddress,
      row.deviceId,
      row.reason,
      row.requestId,
      auditPayloadCell(row.before),
      auditPayloadCell(row.after)
    ]
      .map(csvCell)
      .join(",")
  );

  return [header.join(","), ...body].join("\r\n");
}

export async function exportAuditHistoryCsv(
  ctx: AuditActorContext,
  filters: AuditHistoryFilters,
  deps: AuditServiceDeps = {}
): Promise<string> {
  assertAllowed(ctx, "export");
  const requestId = deps.requestId ?? crypto.randomUUID();
  const limit = 1000;

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new AuditRepository(tx, ctx.organizationId);
    const rows = await repository.list(filters, limit);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "audit.export.generated",
      resourceType: auditLogResource,
      resourceId: null,
      ipAddress: deps.ipAddress ?? null,
      after: {
        filters: Object.fromEntries(
          Object.entries(filters).map(([key, value]) => [
            key,
            value instanceof Date ? value.toISOString() : value
          ])
        ),
        rowCount: rows.length
      },
      reason: "Audit history export",
      requestId,
      occurredAt: new Date()
    });

    return auditHistoryCsv(rows);
  });
}
