import { headers } from "next/headers";
import { OrganizationRepository } from "@/modules/organization/infrastructure/organization-repository";
import {
  organizationSettingsInputSchema,
  type OrganizationSettingsInput,
  type OrganizationSettingsSummary
} from "@/modules/organization/domain/organization-settings";
import {
  assertOrganizationAllowed,
  type OrganizationActorContext
} from "@/modules/organization/application/organization-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

type OrganizationServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function db(deps: OrganizationServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

async function auditMeta(deps: OrganizationServiceDeps): Promise<AuditMeta> {
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

export class OrganizationNotFoundError extends Error {
  constructor(message = "Organization was not found") {
    super(message);
    this.name = "OrganizationNotFoundError";
  }
}

export class OrganizationCurrencyLockedError extends Error {
  constructor(message = "Organization base currency cannot be changed after financial setup") {
    super(message);
    this.name = "OrganizationCurrencyLockedError";
  }
}

export function parseOrganizationSettingsInput(input: unknown) {
  return organizationSettingsInputSchema.safeParse(input);
}

export async function getOrganizationSettings(
  ctx: OrganizationActorContext,
  deps: OrganizationServiceDeps = {}
): Promise<OrganizationSettingsSummary> {
  assertOrganizationAllowed(ctx, "view");

  const settings = await withTenant(db(deps), ctx.organizationId, async (tx) =>
    new OrganizationRepository(tx, ctx.organizationId).findSettings()
  );

  if (!settings) {
    throw new OrganizationNotFoundError();
  }

  return settings;
}

export async function updateOrganizationSettings(
  ctx: OrganizationActorContext,
  input: OrganizationSettingsInput,
  deps: OrganizationServiceDeps = {}
): Promise<OrganizationSettingsSummary> {
  assertOrganizationAllowed(ctx, "edit");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new OrganizationRepository(tx, ctx.organizationId);
    const before = await repository.findSettings();

    if (!before) {
      throw new OrganizationNotFoundError();
    }

    if (input.baseCurrency !== before.baseCurrency) {
      assertOrganizationAllowed(ctx, "configure");

      if (before.baseCurrencyLocked) {
        throw new OrganizationCurrencyLockedError();
      }
    }

    const after = await repository.updateSettings(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "organization.settings.update",
      resourceType: "organization",
      resourceId: ctx.organizationId,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      before,
      after,
      reason: "Organization settings updated",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return after;
  });
}
