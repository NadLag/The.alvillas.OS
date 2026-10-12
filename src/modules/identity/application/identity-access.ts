import type { Session } from "next-auth";
import { identityResource } from "@/modules/identity/domain/identity";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

export type IdentityActorContext = {
  organizationId: string;
  actorId: string;
  personId: string;
  authContext: AuthContext;
};

type RolePermissionRow = {
  role: {
    rolePermissions: Array<{
      permission: {
        key: string;
      };
    }>;
  };
  scopeType: string;
  scopeId: string | null;
};

type IdentityAccessDeps = {
  db?: TenantTransactionRunner;
};

function db(deps: IdentityAccessDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

export async function authContextForAccount(
  organizationId: string,
  userAccountId: string,
  deps: IdentityAccessDeps = {}
): Promise<AuthContext> {
  return withTenant(db(deps), organizationId, async (tx) => {
    const assignments = (await tx.roleAssignment.findMany({
      where: {
        organizationId,
        userAccountId,
        archivedAt: null,
        validFrom: { lte: new Date() },
        OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
      },
      include: {
        role: {
          include: {
            rolePermissions: {
              include: {
                permission: true
              }
            }
          }
        }
      }
    })) as RolePermissionRow[];

    const permissions = new Set<string>();
    const scopes = assignments.map((assignment) => {
      for (const rolePermission of assignment.role.rolePermissions) {
        permissions.add(rolePermission.permission.key);
      }

      return {
        organizationId,
        resourceType: assignment.scopeType === "organization" ? undefined : assignment.scopeType,
        resourceId: assignment.scopeId ?? undefined
      };
    });

    return {
      organizationId,
      permissions,
      scopes: scopes.length > 0 ? scopes : [{ organizationId }]
    };
  });
}

export async function identityActorContextFromSession(
  session: Session | null,
  deps: IdentityAccessDeps = {}
): Promise<IdentityActorContext | null> {
  const user = session?.user;

  if (!user?.id || !user.personId || !user.organizationId) {
    return null;
  }

  return {
    organizationId: user.organizationId,
    actorId: user.id,
    personId: user.personId,
    authContext: await authContextForAccount(user.organizationId, user.id, deps)
  };
}

export function assertIdentityAllowed(
  ctx: IdentityActorContext,
  action: Parameters<typeof authorize>[1],
  id?: string
): void {
  if (
    !authorize(ctx.authContext, action, {
      type: identityResource,
      organizationId: ctx.organizationId,
      id
    })
  ) {
    throw new IdentityAuthorizationError();
  }
}

export class IdentityAuthorizationError extends Error {
  constructor(message = "Identity action is not authorized") {
    super(message);
    this.name = "IdentityAuthorizationError";
  }
}
