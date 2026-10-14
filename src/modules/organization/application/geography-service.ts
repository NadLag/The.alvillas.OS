import { headers } from "next/headers";
import { GeographyRepository } from "@/modules/organization/infrastructure/geography-repository";
import {
  cityInputSchema,
  regionInputSchema,
  type CityInput,
  type CitySummary,
  type GeographySummary,
  type RegionInput,
  type RegionSummary
} from "@/modules/organization/domain/geography";
import {
  type OrganizationActorContext
} from "@/modules/organization/application/organization-access";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, authorizeCollection, type Action } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

type GeographyResource = "region" | "city";

type GeographyServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function db(deps: GeographyServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

async function auditMeta(deps: GeographyServiceDeps): Promise<AuditMeta> {
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

function assertGeographyAllowed(
  ctx: OrganizationActorContext,
  resource: GeographyResource,
  action: Action,
  id?: string
): void {
  const allowed = id
    ? authorize(
        ctx.authContext,
        action,
        resource === "region"
          ? { type: resource, organizationId: ctx.organizationId, id, region: id }
          : { type: resource, organizationId: ctx.organizationId, id, city: id }
      )
    : authorizeCollection(ctx.authContext, action, resource);

  if (!allowed) {
    throw new GeographyAuthorizationError();
  }
}

export class GeographyAuthorizationError extends Error {
  constructor(message = "Geography action is not authorized") {
    super(message);
    this.name = "GeographyAuthorizationError";
  }
}

export class GeographyNotFoundError extends Error {
  constructor(message = "Geography resource was not found") {
    super(message);
    this.name = "GeographyNotFoundError";
  }
}

export class GeographyConflictError extends Error {
  constructor(message = "Geography resource is still in use") {
    super(message);
    this.name = "GeographyConflictError";
  }
}

export function parseRegionInput(input: unknown) {
  return regionInputSchema.safeParse(input);
}

export function parseCityInput(input: unknown) {
  return cityInputSchema.safeParse(input);
}

export async function listGeography(
  ctx: OrganizationActorContext,
  deps: GeographyServiceDeps = {}
): Promise<GeographySummary> {
  assertGeographyAllowed(ctx, "region", "view");
  assertGeographyAllowed(ctx, "city", "view");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    new GeographyRepository(tx, ctx.organizationId).listGeography()
  );
}

export async function createRegion(
  ctx: OrganizationActorContext,
  input: RegionInput,
  deps: GeographyServiceDeps = {}
): Promise<RegionSummary> {
  assertGeographyAllowed(ctx, "region", "create");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new GeographyRepository(tx, ctx.organizationId);
    const region = await repository.createRegion(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "region.create",
      resourceType: "region",
      resourceId: region.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      after: region,
      reason: "Region created",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return region;
  });
}

export async function createCity(
  ctx: OrganizationActorContext,
  input: CityInput,
  deps: GeographyServiceDeps = {}
): Promise<CitySummary> {
  assertGeographyAllowed(ctx, "city", "create");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new GeographyRepository(tx, ctx.organizationId);

    if (input.regionId && !(await repository.findRegion(input.regionId))) {
      throw new GeographyNotFoundError("Region does not exist in this organization");
    }

    const city = await repository.createCity(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "city.create",
      resourceType: "city",
      resourceId: city.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      after: city,
      reason: "City created",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return city;
  });
}

export async function archiveRegion(
  ctx: OrganizationActorContext,
  regionId: string,
  deps: GeographyServiceDeps = {}
): Promise<RegionSummary> {
  assertGeographyAllowed(ctx, "region", "edit", regionId);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new GeographyRepository(tx, ctx.organizationId);
    const before = await repository.findRegion(regionId);

    if (!before) {
      throw new GeographyNotFoundError();
    }

    const dependents = await repository.countActiveRegionDependents(regionId);

    if (dependents.cities > 0 || dependents.properties > 0) {
      throw new GeographyConflictError("Archive cities and move properties before archiving this region");
    }

    const after = await repository.archiveRegion(regionId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "region.archive",
      resourceType: "region",
      resourceId: regionId,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      before,
      after,
      reason: "Region archived",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return after;
  });
}

export async function archiveCity(
  ctx: OrganizationActorContext,
  cityId: string,
  deps: GeographyServiceDeps = {}
): Promise<CitySummary> {
  assertGeographyAllowed(ctx, "city", "edit", cityId);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new GeographyRepository(tx, ctx.organizationId);
    const before = await repository.findCity(cityId);

    if (!before) {
      throw new GeographyNotFoundError();
    }

    if ((await repository.countActiveCityProperties(cityId)) > 0) {
      throw new GeographyConflictError("Move properties before archiving this city");
    }

    const after = await repository.archiveCity(cityId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "city.archive",
      resourceType: "city",
      resourceId: cityId,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      before,
      after,
      reason: "City archived",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return after;
  });
}
