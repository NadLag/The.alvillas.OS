import { headers } from "next/headers";
import type { AuthContext } from "@/platform/authz/authorize";
import { authorize } from "@/platform/authz/authorize";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import {
  auditLogFilterSchema,
  parseAuditLogFilters,
  type AuditLogFilterInput
} from "@/modules/audit/domain/audit";
import {
  AuditRepository,
  type AuditRecordPage,
  type AuditRecordSummary
} from "@/modules/audit/infrastructure/audit-repository";

export class AuditAuthorizationError extends Error {
  constructor(message = "Audit action is not authorized") {
    super(message);
    this.name = "AuditAuthorizationError";
  }
}

export class AuditValidationError extends Error {
  constructor(message = "Audit filters are invalid") {
    super(message);
    this.name = "AuditValidationError";
  }
}

export type AuditActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

type AuditServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function db(deps: AuditServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

async function auditMeta(deps: AuditServiceDeps): Promise<AuditMeta> {
  if (deps.requestId) {
    return {
      requestId: deps.requestId,
      ipAddress: deps.ipAddress ?? null
    };
  }

  const requestHeaders = await headers();

  return {
    requestId: requestHeaders.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  };
}

function assertAuditAllowed(ctx: AuditActorContext, action: "view" | "export"): void {
  if (
    !authorize(ctx.authContext, action, {
      type: "audit_log",
      organizationId: ctx.organizationId
    })
  ) {
    throw new AuditAuthorizationError();
  }
}

export function parseAuditFilters(input: unknown): AuditLogFilterInput {
  const parsed = parseAuditLogFilters(input);

  if (!parsed.success) {
    throw new AuditValidationError();
  }

  return parsed.data;
}

export async function listAuditRecords(
  ctx: AuditActorContext,
  filters: AuditLogFilterInput,
  deps: AuditServiceDeps = {}
): Promise<AuditRecordPage> {
  assertAuditAllowed(ctx, "view");
  const parsed = auditLogFilterSchema.parse(filters);

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    new AuditRepository(tx, ctx.organizationId).list(parsed)
  );
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

  return `"${raw.replaceAll("\"", "\"\"")}"`;
}

export function auditRecordsToCsv(records: readonly AuditRecordSummary[]): string {
  const header = [
    "id",
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
  const rows = records.map((record) =>
    [
      record.id,
      record.occurredAt,
      record.actorId,
      record.action,
      record.resourceType,
      record.resourceId,
      record.propertyScopeId,
      record.ipAddress,
      record.deviceId,
      record.reason,
      record.requestId,
      record.before,
      record.after
    ]
      .map(csvCell)
      .join(",")
  );

  return [header.join(","), ...rows].join("\n");
}

export async function exportAuditRecords(
  ctx: AuditActorContext,
  filters: AuditLogFilterInput,
  deps: AuditServiceDeps = {}
): Promise<{ csv: string; rowCount: number }> {
  assertAuditAllowed(ctx, "export");
  const parsed = auditLogFilterSchema.parse({ ...filters, limit: Math.min(filters.limit ?? 200, 200) });
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new AuditRepository(tx, ctx.organizationId);
    const page = await repository.list(parsed);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "audit_log.export",
      resourceType: "audit_log",
      resourceId: null,
      ipAddress: meta.ipAddress,
      before: {
        filters: {
          action: parsed.action ?? null,
          resourceType: parsed.resourceType ?? null,
          actorId: parsed.actorId ?? null,
          requestId: parsed.requestId ?? null,
          from: parsed.from?.toISOString() ?? null,
          to: parsed.to?.toISOString() ?? null,
          limit: parsed.limit
        }
      },
      after: {
        rowCount: page.records.length,
        totalMatched: page.total
      },
      reason: "Audit export generated",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return {
      csv: auditRecordsToCsv(page.records),
      rowCount: page.records.length
    };
  });
}

