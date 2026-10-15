import {
  parseAuthorizationConditions,
  type AuthContext,
  type ScopeType
} from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { IdentityRepository } from "@/modules/identity/infrastructure/identity-repository";
import { securityEnrollment } from "@/platform/auth/security-enrollment";

export type RolePermissionRow = {
  role: {
    key: string;
    rolePermissions: Array<{
      permission: {
        key: string;
      };
    }>;
  };
  scopeType: string;
  scopeId: string | null;
  conditions: unknown;
  validFrom: Date;
  validTo: Date | null;
};

type AccountAuthContextDeps = {
  db?: TenantTransactionRunner;
};

function db(deps: AccountAuthContextDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

export async function authContextForAccount(
  organizationId: string,
  userAccountId: string,
  deps: AccountAuthContextDeps = {}
): Promise<AuthContext> {
  return withTenant(db(deps), organizationId, async (tx) => {
    const account = await new IdentityRepository(tx, organizationId).findSessionSecurityAccount(userAccountId);
    if (!account || securityEnrollment(account).setupRequired) {
      return { organizationId, userAccountId, permissions: new Set<string>(), scopes: [{ organizationId }], assignments: [] };
    }
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

    return contextForRoleAssignments(organizationId, userAccountId, assignments);
  });
}

export function contextForRoleAssignments(organizationId: string, userAccountId: string, assignments: RolePermissionRow[]): AuthContext {
    const permissions = new Set<string>();
    const authAssignments = assignments.map((assignment) => {
      const assignmentPermissions = new Set<string>();

      for (const rolePermission of assignment.role.rolePermissions) {
        permissions.add(rolePermission.permission.key);
        assignmentPermissions.add(rolePermission.permission.key);
      }

      const scope = {
        organizationId,
        scopeType: assignment.scopeType as ScopeType,
        scopeId: assignment.scopeId ?? undefined,
        resourceType: assignment.scopeType === "organization" ? undefined : assignment.scopeType,
        resourceId: assignment.scopeId ?? undefined
      };

      return {
        roleKey: assignment.role.key,
        permissions: assignmentPermissions,
        scope,
        conditions: parseAuthorizationConditions(assignment.conditions),
        validFrom: assignment.validFrom,
        validTo: assignment.validTo
      };
    });
    const scopes = authAssignments.map((assignment) => assignment.scope);

    return {
      organizationId,
      userAccountId,
      permissions,
      scopes: scopes.length > 0 ? scopes : [{ organizationId }],
      assignments: authAssignments
    };
}
