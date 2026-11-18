import { createHash } from "node:crypto";
import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import {
  buildOwnerStatement,
  statementPeriodInputSchema,
  statementPeriodSelectionSchema,
  type StatementPeriodSelection
} from "@/modules/owner-portal/domain/owner-statement";
import type { OwnerPortalActorContext } from "@/modules/owner-portal/application/owner-portal-access";
import {
  presentOwnerStatement,
  type OwnerStatementView,
  type OwnerStatementSnapshot
} from "@/modules/owner-portal/application/owner-statement-presenter";
import { OwnerPortalRepository } from "@/modules/owner-portal/infrastructure/owner-portal-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type DataClass } from "@/platform/authz/authorize";
import { present, type PresentationContext } from "@/platform/authz/present";
import { ownerPropertyCondition, type OwnerPropertyCondition } from "../domain/property-condition";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";

export class OwnerPortalAuthorizationError extends Error {
  constructor(message = "Owner portal action is not authorized") {
    super(message);
    this.name = "OwnerPortalAuthorizationError";
  }
}

export class OwnerPortalNotFoundError extends Error {
  constructor(message = "Owner portal resource was not found") {
    super(message);
    this.name = "OwnerPortalNotFoundError";
  }
}

export type OwnerPortalPropertySummary = {
  ownerId: string;
  ownerName: string;
  propertyId: string;
  propertyName: string;
  city: string;
  shareBps: number;
  canViewFinances: boolean;
  condition?: OwnerPropertyCondition;
};

type OwnerPortalServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function db(deps: OwnerPortalServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

function assertAllowed(
  ctx: OwnerPortalActorContext,
  resource: "owner_portal" | "owner_portal_property" | "owner_statement",
  id?: string
): void {
  const allowed = authorize(ctx.authContext, "view", {
    type: resource,
    organizationId: ctx.organizationId,
    id
  });

  if (!allowed) {
    throw new OwnerPortalAuthorizationError();
  }
}

async function auditMeta(deps: OwnerPortalServiceDeps): Promise<AuditMeta> {
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

function ownerPresentationContext(ctx: OwnerPortalActorContext): PresentationContext {
  return {
    ...ctx.authContext,
    visibleDataClasses: new Set<DataClass>(["operational", "financial"])
  };
}

function toAuditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function statementHash(statement: OwnerStatementView): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 2,
        organizationId: statement.organizationId,
        ownerId: statement.ownerId,
        propertyId: statement.propertyId,
        periodStart: statement.periodStart.toISOString(),
        periodEnd: statement.periodEnd.toISOString(),
        timezone: statement.timezone,
        fromOn: statement.fromOn,
        toOn: statement.toOn,
        currency: statement.currency,
        openingBalance: statement.openingBalance.toJSON(),
        periodCreditTotal: statement.periodCreditTotal.toJSON(),
        periodDebitTotal: statement.periodDebitTotal.toJSON(),
        closingBalance: statement.closingBalance.toJSON(),
        bucketTotals: Object.fromEntries(
          Object.entries(statement.bucketTotals).map(([bucket, amount]) => [
            bucket,
            amount.toJSON()
          ])
        ),
        lines: statement.lines.map((line) => ({
          postingId: line.postingId,
          transactionId: line.transactionId,
          bucket: line.bucket,
          side: line.side,
          amount: line.amount.toJSON()
        }))
      })
    )
    .digest("hex");
}

export async function listOwnerPortalProperties(
  ctx: OwnerPortalActorContext,
  deps: OwnerPortalServiceDeps = {},
  options: { includeCondition?: boolean } = {}
): Promise<OwnerPortalPropertySummary[]> {
  assertAllowed(ctx, "owner_portal");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new OwnerPortalRepository(tx, ctx.organizationId);
    const rows = await repository.listOwnerProperties(ctx.actorId);

    const available = rows.filter((row) =>
      authorize(ctx.authContext, "view", {
        type: "owner_portal_property",
        organizationId: ctx.organizationId,
        id: row.propertyId
      })
    );
    if (!options.includeCondition) return available;
    const signals = await repository.conditionSignals(ctx.actorId, [...new Set(available.map(row => row.propertyId))]);
    const conditions = new Map(signals.map(signal => [signal.propertyId, presentsCondition(ctx, signal)]));
    return available.map(row => ({ ...row, condition: conditions.get(row.propertyId) }));
  });
}

function presentsCondition(ctx: OwnerPortalActorContext, signal: { propertyId: string; openIssue: boolean; waitingForWork: boolean }) {
  const shown = present(ownerPresentationContext(ctx), "view", {
    type: "owner_portal_property", organizationId: ctx.organizationId, id: signal.propertyId,
    dataClass: "operational", data: { condition: ownerPropertyCondition(signal) }
  }, { condition: { dataClass: "operational", mask: "omit" } });
  if (!shown.condition) throw new OwnerPortalAuthorizationError();
  return shown.condition;
}

export async function getOwnerPropertyCondition(ctx: OwnerPortalActorContext, propertyId: string, deps: OwnerPortalServiceDeps = {}) {
  assertAllowed(ctx, "owner_portal_property", propertyId);
  return withTenant(db(deps), ctx.organizationId, async tx => {
    const repository = new OwnerPortalRepository(tx, ctx.organizationId);
    const [signal] = await repository.conditionSignals(ctx.actorId, [propertyId]);
    if (!signal) throw new OwnerPortalNotFoundError();
    return presentsCondition(ctx, signal);
  });
}

export async function getOwnerStatement(
  ctx: OwnerPortalActorContext,
  propertyId: string,
  periodInput: StatementPeriodSelection = {},
  deps: OwnerPortalServiceDeps = {}
): Promise<OwnerStatementSnapshot> {
  return readOwnerStatement(ctx, propertyId, periodInput, deps, statement => statement);
}

export async function readOwnerStatement<T>(
  ctx: OwnerPortalActorContext,
  propertyId: string,
  periodInput: StatementPeriodSelection,
  deps: OwnerPortalServiceDeps,
  read: (statement: OwnerStatementSnapshot, tx: TenantTransaction) => T | Promise<T>
): Promise<T> {
  assertAllowed(ctx, "owner_statement", propertyId);
  const selection = statementPeriodSelectionSchema.parse(periodInput);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new OwnerPortalRepository(tx, ctx.organizationId);
    const access = await repository.findOwnerPropertyAccess(ctx.actorId, propertyId, true);

    if (!access) {
      throw new OwnerPortalNotFoundError();
    }

    const configured = await repository.configuration(), defaults = await repository.defaults(configured.now, configured.timezone),
      parsedPeriod = statementPeriodInputSchema.parse({ from: selection.from ?? defaults.fromOn, to: selection.to ?? defaults.toOn, currency: selection.currency }),
      currency = parsedPeriod.currency ?? configured.baseCurrency;
    if (!configured.currencies.some(row => row.code === currency)) throw new OwnerPortalNotFoundError();
    const { startsAt: periodStart, endsAt: periodEnd } = await repository.range(parsedPeriod.from, parsedPeriod.to, configured.timezone);
    const postings = await repository.listOwnerLedgerPostings({
        ownerId: access.ownerId,
        propertyId,
        periodEnd,
        currency,
        includeLocations: false
      });
    const statement = buildOwnerStatement({
      organizationId: ctx.organizationId,
      ownerId: access.ownerId,
      ownerName: access.ownerName,
      propertyId,
      propertyName: access.propertyName,
      periodStart,
      periodEnd,
      currency,
      postings
    });
    const presented = { ...presentOwnerStatement(ownerPresentationContext(ctx), statement), timezone: configured.timezone,
      fromOn: parsedPeriod.from, toOn: parsedPeriod.to, currencies: configured.currencies };
    const hash = statementHash(presented);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "owner_statement.view",
      resourceType: "owner_statement",
      resourceId: propertyId,
      ipAddress: meta.ipAddress,
      propertyScopeId: propertyId,
      after: toAuditJson({
        statementHash: hash,
        statementHashVersion: 2,
        ownerId: access.ownerId,
        propertyId,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        timezone: configured.timezone,
        calendarPolicyId: configured.policyId,
        fromOn: parsedPeriod.from,
        toOn: parsedPeriod.to,
        currency,
        openingBalance: presented.openingBalance.toJSON(),
        periodCreditTotal: presented.periodCreditTotal.toJSON(),
        periodDebitTotal: presented.periodDebitTotal.toJSON(),
        closingBalance: presented.closingBalance.toJSON(),
        lineCount: presented.lines.length
      }),
      reason: "Viewed the authorized original owner statement",
      requestId: meta.requestId,
      occurredAt: configured.now
    });

    return await read(presented, tx);
  }, { isolationLevel: "RepeatableRead" });
}
