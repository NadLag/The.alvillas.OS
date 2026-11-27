import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { fieldPolicyCatalog, permissionCatalog, standardRoles } from "@/platform/authz/catalog";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

const organizationId = "018f0a0b-0000-7000-9000-000000000001";

type RolePermissionCreateManyArgs = {
  data: Array<{
    organizationId: string;
    roleId: string;
    permissionId: string;
  }>;
  skipDuplicates: boolean;
};

describe("standard identity setup", () => {
  it("repairs a stale standard catalog with batched role permissions and field policies", async () => {
    const roleFindMany = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        standardRoles.map((role) => ({
          id: `role-${role.key}`,
          key: role.key
        }))
      );
    const permissionFindMany = vi.fn(() =>
      Promise.resolve(
        permissionCatalog.map((permission) => ({
          id: `permission-${permission.key}`,
          key: permission.key
        }))
      )
    );
    const rolePermissionCreateMany = vi.fn(
      (args: RolePermissionCreateManyArgs) => {
        void args;

        return Promise.resolve({ count: 0 });
      }
    );
    const tx = {
      $executeRaw: vi.fn((statement: Prisma.Sql) => {
        void statement;
        return Promise.resolve(1);
      }),
      permission: {
        count: vi.fn(() => Promise.resolve(0)),
        createMany: vi.fn(() => Promise.resolve({ count: permissionCatalog.length })),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        findMany: permissionFindMany
      },
      fieldPolicy: {
        count: vi.fn(() => Promise.resolve(0))
      },
      role: {
        findMany: roleFindMany,
        createMany: vi.fn(() => Promise.resolve({ count: standardRoles.length })),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 }))
      },
      rolePermission: {
        createMany: rolePermissionCreateMany
      }
    };
    const db: TenantTransactionRunner = {
      $transaction: (callback) => callback(tx as unknown as TenantTransaction)
    };

    await ensureStandardIdentitySetup(organizationId, { db });

    const expectedRolePermissionCount = standardRoles.reduce(
      (count, role) => count + role.permissions.length,
      0
    );
    expect(rolePermissionCreateMany).toHaveBeenCalledOnce();
    const firstCreateManyCall = rolePermissionCreateMany.mock.calls.at(0)?.[0];
    expect(firstCreateManyCall?.skipDuplicates).toBe(true);
    expect(firstCreateManyCall?.data).toContainEqual({
      organizationId,
      roleId: "role-admin",
      permissionId: "permission-organization:view"
    });
    expect(firstCreateManyCall?.data).toHaveLength(expectedRolePermissionCount);
    const policyWrites = tx.$executeRaw.mock.calls.map(([statement]) => statement)
      .filter(statement => statement.sql.includes("INSERT INTO public.field_policy"));
    expect(policyWrites).toHaveLength(1);
    expect(policyWrites[0]?.values).toEqual(fieldPolicyCatalog.flatMap(policy => [
      organizationId, policy.resource, policy.field, policy.dataClass, policy.requiredPermission, policy.mask
    ]));
  });
});
