import { z } from "zod";
import {
  AuditRepository,
  type AuditHistoryFilters,
  type AuditHistoryRow
} from "@/modules/audit/infrastructure/audit-repository";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type Action, type Resource } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { canViewCompleteOwnerLedger } from "@/modules/finance/domain/owner-ledger";

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
  action: "view" | "export" = "view",
  financialResource?: Resource
): AuditHistoryRow {
  if (["cash_collection", "expense", "owner_payout", "financial_transaction", "ledger_account", "transaction_group", "accounting_period"].includes(row.resourceType)) {
    const expectedType = ["owner_payout", "ledger_account", "transaction_group", "accounting_period"].includes(row.resourceType) ? "financial_transaction" : row.resourceType;
    const requiresSourceId = ["owner_payout", "financial_transaction", "ledger_account", "transaction_group", "accounting_period"].includes(row.resourceType);
    const permissionResource = ["transaction_group", "accounting_period"].includes(row.resourceType) ?
      { type: "financial_transaction", organizationId: ctx.organizationId, dataClass: "financial" as const } : financialResource;
    const allowed = Boolean(financialResource && financialResource.type === expectedType &&
      (!requiresSourceId || financialResource.id === row.resourceId) && permissionResource && authorize(ctx.authContext, action, permissionResource) &&
      [row.before, row.after].every(value => {
        if(row.resourceType==="owner_payout")return payoutAuditPayloadAllowed(ctx,value,permissionResource,action);
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "amount")) return true;
        return typeof value.amount === "string" && /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(value.amount) &&
          authorize(ctx.authContext, action, { ...permissionResource, amount: value.amount });
      }));
    return present({ ...ctx.authContext, visibleDataClasses: new Set(allowed ? ["financial"] : []) }, action,
      { type: auditLogResource, organizationId: ctx.organizationId, propertyId: row.propertyScopeId, data: row },
      { before: { dataClass: "financial" }, after: { dataClass: "financial" }, reason: { dataClass: "financial" } }) as AuditHistoryRow;
  }
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

function payoutAuditPayloadAllowed(ctx:AuditActorContext,value:unknown,source:Resource,action:"view"|"export"){
  if(!value||typeof value!=="object"||Array.isArray(value))return true;
  const payload=value as Record<string,unknown>,request=z.record(z.string(),z.unknown()).safeParse(payload.request);
  const amounts=[...(Object.hasOwn(payload,"amount")?[payload.amount]:[]),...(request.success&&Object.hasOwn(request.data,"amount")?[request.data.amount]:[])];
  if(amounts.some(value=>{
    const money=z.object({amount:z.string(),currency:z.string().regex(/^[A-Z]{3}$/u)}).safeParse(value),amount=typeof value==="string"?value:money.success?money.data.amount:null;
    return !amount||!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u.test(amount)||!authorize(ctx.authContext,action,{...source,amount});
  }))return false;
  if(Object.hasOwn(payload,"policy"))return canViewCompleteOwnerLedger(ctx.authContext,{type:"financial_transaction",organizationId:ctx.organizationId,
    ownerId:source.ownerId,propertyId:source.propertyId,city:source.city,region:source.region,dataClass:"financial"},new Date(),action);
  return true;
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

async function financialAuditResources(repository: AuditRepository, rows: AuditHistoryRow[]): Promise<Map<string, Resource>> {
  const read = (type: string, load: (ids: string[]) => Promise<Map<string, Resource>>) => {
    const ids = [...new Set(rows.filter(row => row.resourceType === type).flatMap(row => row.resourceId ? [row.resourceId] : []))];
    return ids.length ? load(ids) : Promise.resolve(new Map<string, Resource>());
  };
  const [cash, expenses, payouts, transactions, accounts, groups, periods] = await Promise.all([
    read("cash_collection", ids => repository.cashResources(ids)),
    read("expense", ids => repository.expenseResources(ids)),
    read("owner_payout",ids=>repository.payoutResources(ids)),
    read("financial_transaction", ids => repository.transactionResources(ids)),
    read("ledger_account", ids => repository.ledgerAccountResources(ids)),
    read("transaction_group", ids => repository.transactionGroupResources(ids)),
    read("accounting_period", ids => repository.accountingPeriodResources(ids))
  ]);
  return new Map([
    ...[...cash].map(([id, resource]) => [`cash_collection:${id}`, resource] as const),
    ...[...expenses].map(([id, resource]) => [`expense:${id}`, resource] as const),
    ...[...payouts].map(([id,resource])=>[`owner_payout:${id}`,resource] as const),
    ...[...transactions].map(([id, resource]) => [`financial_transaction:${id}`, resource] as const),
    ...[...accounts].map(([id, resource]) => [`ledger_account:${id}`, resource] as const),
    ...[...groups].map(([id, resource]) => [`transaction_group:${id}`, resource] as const),
    ...[...periods].map(([id, resource]) => [`accounting_period:${id}`, resource] as const)
  ]);
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

    const resources = await financialAuditResources(repository, rows);
    return { rows: rows.map((row) => presentAuditHistoryRow(ctx, row, "view", row.resourceId ? resources.get(`${row.resourceType}:${row.resourceId}`) : undefined)), total, limit };
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

    const resources = await financialAuditResources(repository, rows);
    return auditHistoryCsv(rows.map((row) => presentAuditHistoryRow(ctx, row, "export", row.resourceId ? resources.get(`${row.resourceType}:${row.resourceId}`) : undefined)));
  });
}
