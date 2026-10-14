import { headers } from "next/headers";
import { CoreRepository } from "@/modules/core/infrastructure/core-repository";
import {
  ownerInputSchema,
  propertyInputSchema,
  type OwnerInput,
  type OwnerSummary,
  type PropertyInput,
  type PropertySummary
} from "@/modules/core/domain/owner-property";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, authorizeCollection } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { CoreActorContext } from "@/modules/core/application/core-access";

export class CoreAuthorizationError extends Error {
  constructor(message = "Core action is not authorized") {
    super(message);
    this.name = "CoreAuthorizationError";
  }
}

export class CoreNotFoundError extends Error {
  constructor(message = "Core resource was not found") {
    super(message);
    this.name = "CoreNotFoundError";
  }
}

type CoreServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

function assertAllowed(ctx: CoreActorContext, action: "view" | "create", resource: "owner" | "property", id?: string): void {
  const allowed = id
    ? authorize(ctx.authContext, action, {
        type: resource,
        organizationId: ctx.organizationId,
        id,
        ownerId: resource === "owner" ? id : undefined,
        propertyId: resource === "property" ? id : undefined
      })
    : authorizeCollection(ctx.authContext, action, resource);

  if (!allowed) {
    throw new CoreAuthorizationError();
  }
}

async function auditMeta(deps: CoreServiceDeps): Promise<AuditMeta> {
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

function db(deps: CoreServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

export function parseOwnerInput(input: unknown) {
  return ownerInputSchema.safeParse(input);
}

export function parsePropertyInput(input: unknown) {
  return propertyInputSchema.safeParse(input);
}

export async function createOwner(
  ctx: CoreActorContext,
  input: OwnerInput,
  deps: CoreServiceDeps = {}
): Promise<OwnerSummary> {
  assertAllowed(ctx, "create", "owner");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const owner = await repository.createOwner(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "owner.create",
      resourceType: "owner",
      resourceId: owner.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: null,
      after: owner,
      reason: "S2 owner creation",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return owner;
  });
}

export async function listOwners(
  ctx: CoreActorContext,
  deps: CoreServiceDeps = {}
): Promise<OwnerSummary[]> {
  assertAllowed(ctx, "view", "owner");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new CoreRepository(tx, ctx.organizationId).listOwners()).filter((owner) =>
      authorize(ctx.authContext, "view", {
        type: "owner",
        organizationId: ctx.organizationId,
        id: owner.id,
        ownerId: owner.id
      })
    )
  );
}

export async function getOwner(
  ctx: CoreActorContext,
  ownerId: string,
  deps: CoreServiceDeps = {}
): Promise<OwnerSummary> {
  assertAllowed(ctx, "view", "owner", ownerId);

  const owner = await withTenant(db(deps), ctx.organizationId, async (tx) =>
    new CoreRepository(tx, ctx.organizationId).findOwner(ownerId)
  );

  if (!owner) {
    throw new CoreNotFoundError();
  }

  return owner;
}

export async function createProperty(
  ctx: CoreActorContext,
  input: PropertyInput,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary> {
  assertAllowed(ctx, "create", "property");
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new CoreRepository(tx, ctx.organizationId);
    const owner = await repository.findOwner(input.ownerId);

    if (!owner) {
      throw new CoreNotFoundError("Owner does not exist in this tenant");
    }

    const property = await repository.createProperty(input, ctx.actorId);

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "property.create",
      resourceType: "property",
      resourceId: property.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: property.id,
      after: property,
      reason: "S2 property creation",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return property;
  });
}

export async function listProperties(
  ctx: CoreActorContext,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary[]> {
  assertAllowed(ctx, "view", "property");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    (await new CoreRepository(tx, ctx.organizationId).listProperties()).filter((property) =>
      authorize(ctx.authContext, "view", {
        type: "property",
        organizationId: ctx.organizationId,
        id: property.id,
        propertyId: property.id,
        city: property.cityId,
        region: property.regionId
      })
    )
  );
}

export async function getProperty(
  ctx: CoreActorContext,
  propertyId: string,
  deps: CoreServiceDeps = {}
): Promise<PropertySummary> {
  assertAllowed(ctx, "view", "property", propertyId);

  const property = await withTenant(db(deps), ctx.organizationId, async (tx) =>
    new CoreRepository(tx, ctx.organizationId).findProperty(propertyId)
  );

  if (!property) {
    throw new CoreNotFoundError();
  }

  return property;
}
