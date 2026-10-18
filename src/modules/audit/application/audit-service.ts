import { z } from "zod";
import {
  AuditRepository,
  type AuditHistoryFilters,
  type AuditHistoryRow
} from "@/modules/audit/infrastructure/audit-repository";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type Action } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
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

function containsServicePricing(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      key === "services.pricing" ||
      key.startsWith("/rules/services.pricing/") ||
      (key === "kind" && item === "SERVICE_CATALOG") ||
      (key === "key" && item === "services.pricing") ||
      containsServicePricing(item)
  );
}

export function presentAuditHistoryRow(
  ctx: AuditActorContext,
  row: AuditHistoryRow,
  action: "view" | "export" = "view"
): AuditHistoryRow {
  const teamResource = row.action.startsWith("team.compensation.")
    ? "staff_compensation"
    : row.action.startsWith("team.document.")
      ? "staff_document"
      : row.action.startsWith("team.wallet.")
        ? "wallet"
        : row.action.startsWith("team.assignment.")
          ? "role"
          : row.action.startsWith("team.availability.") ||
              row.action === "team.member.offboard" ||
              row.action.startsWith("identity.person.")
            ? "identity"
            : null;
  if (teamResource) {
    const subject =
      row.after &&
      typeof row.after === "object" &&
      !Array.isArray(row.after) &&
      typeof row.after.personId === "string"
        ? row.after.personId
        : row.resourceId;
    const resource = { organizationId: ctx.organizationId, propertyId: row.propertyScopeId };
    const allowed =
      (teamResource === "identity" && subject === ctx.personId) ||
      authorize(
        ctx.authContext,
        teamResource === "identity" ? "edit" : teamResource === "role" ? "assign" : "view",
        {
          ...resource,
          type: teamResource,
          id: subject ?? undefined,
          walletId: teamResource === "wallet" ? row.resourceId : undefined
        }
      );
    return present(
      { ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["sensitive"] : []) },
      action,
      { ...resource, type: auditLogResource, data: row },
      {
        ...(teamResource === "identity" && !row.action.startsWith("identity.person.")
          ? {}
          : { before: { dataClass: "sensitive" as const }, after: { dataClass: "sensitive" as const } }),
        reason: { dataClass: "sensitive" }
      }
    ) as AuditHistoryRow;
  }
  if (
    !["property_template", "property_template_revision", "config_rule"].includes(row.resourceType) ||
    (!containsServicePricing(row.before) && !containsServicePricing(row.after))
  )
    return row;
  const resource = { organizationId: ctx.organizationId, propertyId: row.propertyScopeId };
  const financial = authorize(ctx.authContext, "view", { ...resource, type: "financial_transaction" });
  return present(
    { ...ctx.authContext, visibleDataClasses: new Set(financial ? ["financial"] : []) },
    action,
    { ...resource, type: auditLogResource, data: row },
    { before: { dataClass: "financial" }, after: { dataClass: "financial" } }
  ) as AuditHistoryRow;
}

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

    return { rows: rows.map((row) => presentAuditHistoryRow(ctx, row)), total, limit };
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

    return auditHistoryCsv(rows.map((row) => presentAuditHistoryRow(ctx, row, "export")));
  });
}
