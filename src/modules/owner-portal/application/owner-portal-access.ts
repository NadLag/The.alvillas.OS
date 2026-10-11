import type { Session } from "next-auth";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { OwnerPortalRepository } from "@/modules/owner-portal/infrastructure/owner-portal-repository";

export type OwnerPortalActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  ownerIds: readonly string[];
  propertyIds: readonly string[];
  authContext: AuthContext;
};

type OwnerPortalAccessDeps = {
  db?: TenantTransactionRunner;
};

const ownerPortalPermissions = new Set([
  permissionKey("owner_portal", "view"),
  permissionKey("owner_portal_property", "view"),
  permissionKey("owner_statement", "view")
]);

function db(deps: OwnerPortalAccessDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

export async function ownerPortalActorContextFromSession(
  session: Session | null,
  deps: OwnerPortalAccessDeps = {}
): Promise<OwnerPortalActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  return withTenant(db(deps), user.organizationId, async (tx) => {
    const access = await new OwnerPortalRepository(
      tx,
      user.organizationId
    ).listAccessForUser(user.id);

    if (access.ownerIds.length === 0 || access.propertyIds.length === 0) {
      return null;
    }

    return {
      organizationId: user.organizationId,
      actorId: user.id,
      personId: user.personId,
      ownerIds: access.ownerIds,
      propertyIds: access.propertyIds,
      authContext: {
        organizationId: user.organizationId,
        permissions: ownerPortalPermissions,
        scopes: [
          { organizationId: user.organizationId, resourceType: "owner_portal" },
          ...access.propertyIds.flatMap((propertyId) => [
            {
              organizationId: user.organizationId,
              resourceType: "owner_portal_property",
              resourceId: propertyId
            },
            {
              organizationId: user.organizationId,
              resourceType: "owner_statement",
              resourceId: propertyId
            }
          ])
        ]
      }
    };
  });
}
