import { createHash } from "node:crypto";
import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import {
  buildOwnerStatement,
  statementPeriodDates,
  statementPeriodInputSchema,
  type StatementPeriodInput
} from "@/modules/owner-portal/domain/owner-statement";
import type { OwnerPortalActorContext } from "@/modules/owner-portal/application/owner-portal-access";
import {
  presentOwnerStatement,
  type OwnerStatementView
} from "@/modules/owner-portal/application/owner-statement-presenter";
import { OwnerPortalRepository } from "@/modules/owner-portal/infrastructure/owner-portal-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type DataClass } from "@/platform/authz/authorize";
import type { PresentationContext } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

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
        organizationId: statement.organizationId,
        ownerId: statement.ownerId,
        propertyId: statement.propertyId,
        periodStart: statement.periodStart.toISOString(),
        periodEnd: statement.periodEnd.toISOString(),
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
  deps: OwnerPortalServiceDeps = {}
): Promise<OwnerPortalPropertySummary[]> {
  assertAllowed(ctx, "owner_portal");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new OwnerPortalRepository(tx, ctx.organizationId);
    const rows = await repository.listOwnerProperties(ctx.actorId);

    return rows.filter((row) =>
      authorize(ctx.authContext, "view", {
        type: "owner_portal_property",
        organizationId: ctx.organizationId,
        id: row.propertyId
      })
    );
  });
}

export async function getOwnerStatement(
  ctx: OwnerPortalActorContext,
  propertyId: string,
  periodInput: StatementPeriodInput,
  deps: OwnerPortalServiceDeps = {}
): Promise<OwnerStatementView> {
  assertAllowed(ctx, "owner_statement", propertyId);
  const parsedPeriod = statementPeriodInputSchema.parse(periodInput);
  const { periodStart, periodEnd } = statementPeriodDates(parsedPeriod);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new OwnerPortalRepository(tx, ctx.organizationId);
    const access = await repository.findOwnerPropertyAccess(ctx.actorId, propertyId);

    if (!access) {
      throw new OwnerPortalNotFoundError();
    }

    const [organization, postings] = await Promise.all([
      tx.organization.findUniqueOrThrow({
        where: { id: ctx.organizationId },
        select: { baseCurrency: true }
      }),
      repository.listOwnerLedgerPostings({
        ownerId: access.ownerId,
        propertyId,
        periodEnd
      })
    ]);
    const statement = buildOwnerStatement({
      organizationId: ctx.organizationId,
      ownerId: access.ownerId,
      ownerName: access.ownerName,
      propertyId,
      propertyName: access.propertyName,
      periodStart,
      periodEnd,
      currency: organization.baseCurrency,
      postings
    });
    const presented = presentOwnerStatement(ownerPresentationContext(ctx), statement);
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
        ownerId: access.ownerId,
        propertyId,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        openingBalance: presented.openingBalance.toJSON(),
        periodCreditTotal: presented.periodCreditTotal.toJSON(),
        periodDebitTotal: presented.periodDebitTotal.toJSON(),
        closingBalance: presented.closingBalance.toJSON(),
        lineCount: presented.lines.length
      }),
      reason: "S5 owner portal statement",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return presented;
  });
}
