import { describe, expect, it, vi } from "vitest";
import { bootstrapFirstAdmin, bootstrapOrganizationId } from "../../prisma/bootstrap-admin";
import { fieldPolicyCatalog, permissionCatalog, standardRoles } from "@/platform/authz/catalog";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

type ConfigRuleFindFirstArgs = {
  where: {
    organizationId: string;
    key: string;
    scopeType: string;
    scopeId: null;
    archivedAt: null;
  };
};

type ConfigRuleCreateArgs = {
  data: {
    organizationId: string;
    key: string;
    createdBy: string;
  };
};

type AuthCredentialCreateArgs = {
  data: {
    organizationId: string;
    userAccountId: string;
    type: string;
  };
};

type UserAccountUpsertArgs = {
  update: {
    personId: string;
    passwordHash: string;
    status: string;
  };
};

type AuthCredentialUpdateArgs = {
  where: { id: string };
  data: {
    secretHash: string;
    label: string;
  };
};

type RoleAssignmentCreateArgs = {
  data: {
    organizationId: string;
    personId: string;
    userAccountId: string;
    roleId: string;
    scopeType: string;
  };
};

function readyStandardIdentityCatalogMocks() {
  const permission = {
    count: vi.fn(() => Promise.resolve(permissionCatalog.length)),
    createMany: vi.fn(() => Promise.resolve({ count: 0 })),
    updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    findMany: vi.fn(() => Promise.resolve([]))
  };
  const role = {
    findMany: vi.fn(() =>
      Promise.resolve(
        standardRoles.map((roleTemplate) => ({
          key: roleTemplate.key,
          rolePermissions: roleTemplate.permissions.map((permissionKey) => ({
            permission: { key: permissionKey }
          }))
        }))
      )
    ),
    findFirst: vi.fn(() => Promise.resolve({ id: "role-admin", key: "admin" })),
    createMany: vi.fn(() => Promise.resolve({ count: 0 })),
    updateMany: vi.fn(() => Promise.resolve({ count: 0 }))
  };
  const rolePermission = {
    createMany: vi.fn(() => Promise.resolve({ count: 0 }))
  };
  const fieldPolicy = {
    count: vi.fn(() => Promise.resolve(fieldPolicyCatalog.length)),
    upsert: vi.fn(() => Promise.resolve({}))
  };

  return {
    fieldPolicy,
    permission,
    role,
    rolePermission
  };
}

describe("first-admin bootstrap", () => {
  it("requires explicit admin credentials", async () => {
    await expect(
      bootstrapFirstAdmin({} as never, { ADMIN_EMAIL: "", ADMIN_PASSWORD: "" })
    ).rejects.toThrow("ADMIN_EMAIL is required");
  });

  it("creates the organization, person, and account idempotently", async () => {
    const organization = {
      upsert: vi.fn(() => Promise.resolve({ id: bootstrapOrganizationId }))
    };
    const person = {
      upsert: vi.fn(() => Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000002" }))
    };
    const userAccount = {
      findUnique: vi.fn(() => Promise.resolve(null)),
      upsert: vi.fn((args: UserAccountUpsertArgs) => {
        void args;
        return Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000003" });
      })
    };
    const authCredential = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn((args: AuthCredentialCreateArgs) => {
        void args;
        return Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000006" });
      }),
      update: vi.fn(() => Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000006" }))
    };
    const { fieldPolicy, permission, role, rolePermission } = readyStandardIdentityCatalogMocks();
    const roleAssignment = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      create: vi.fn((args: RoleAssignmentCreateArgs) => {
        void args;
        return Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000007" });
      })
    };
    const configRule = {
      findFirst: vi.fn((args: ConfigRuleFindFirstArgs) => {
        void args;
        return Promise.resolve(null);
      }),
      create: vi.fn((args: ConfigRuleCreateArgs) => {
        void args;
        return Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000004" });
      })
    };
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      person,
      userAccount,
      authCredential,
      permission,
      role,
      rolePermission,
      fieldPolicy,
      roleAssignment,
      configRule
    };
    const client: TenantTransactionRunner & { organization: typeof organization } = {
      organization,
      $transaction: (callback) => callback(tx as unknown as TenantTransaction)
    };

    await bootstrapFirstAdmin(client, {
      ADMIN_EMAIL: "Admin@Example.com",
      ADMIN_PASSWORD: "correct horse battery staple"
    });

    expect(organization.upsert).toHaveBeenCalledWith({
      where: { id: bootstrapOrganizationId },
      update: { name: "ALVILLAS SARL", baseCurrency: "MAD" },
      create: { id: bootstrapOrganizationId, name: "ALVILLAS SARL", baseCurrency: "MAD" }
    });
    expect(person.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_email: {
            organizationId: bootstrapOrganizationId,
            email: "admin@example.com"
          }
        }
      })
    );
    expect(userAccount.upsert).toHaveBeenCalledOnce();
    const authCredentialCreateArgs = authCredential.create.mock.calls[0]?.[0];
    expect(authCredentialCreateArgs?.data).toMatchObject({
      organizationId: bootstrapOrganizationId,
      userAccountId: "018f0a0b-0000-7000-9000-000000000003",
      type: "PASSWORD"
    });
    const roleAssignmentCreateArgs = roleAssignment.create.mock.calls[0]?.[0];
    expect(roleAssignmentCreateArgs?.data).toMatchObject({
      organizationId: bootstrapOrganizationId,
      personId: "018f0a0b-0000-7000-9000-000000000002",
      userAccountId: "018f0a0b-0000-7000-9000-000000000003",
      roleId: "role-admin",
      scopeType: "organization"
    });
    expect(configRule.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: bootstrapOrganizationId,
        key: "ops.reservation_task_templates",
        scopeType: "organization",
        scopeId: null,
        archivedAt: null
      }
    });
    expect(configRule.create).toHaveBeenCalledOnce();
    expect(configRule.create.mock.calls[0]?.[0].data).toMatchObject({
      organizationId: bootstrapOrganizationId,
      key: "ops.reservation_task_templates",
      createdBy: "018f0a0b-0000-7000-9000-000000000003"
    });
  });

  it("preserves an existing administrator's credentials, lifecycle, roles, profile and config", async () => {
    const existingPasswordCredentialId = "018f0a0b-0000-7000-9000-000000000006";
    const existingRoleAssignmentId = "018f0a0b-0000-7000-9000-000000000007";
    const existingConfigRuleId = "018f0a0b-0000-7000-9000-000000000004";
    const organization = {
      upsert: vi.fn(() => Promise.resolve({ id: bootstrapOrganizationId }))
    };
    const person = {
      upsert: vi.fn(() => Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000002" }))
    };
    const userAccount = {
      findUnique: vi.fn(() => Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000003" })),
      upsert: vi.fn((args: UserAccountUpsertArgs) => {
        void args;
        return Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000003" });
      })
    };
    const authCredential = {
      findFirst: vi.fn(() => Promise.resolve({ id: existingPasswordCredentialId })),
      create: vi.fn((args: AuthCredentialCreateArgs) => {
        void args;
        return Promise.resolve({ id: "should-not-create" });
      }),
      update: vi.fn((args: AuthCredentialUpdateArgs) => Promise.resolve({ id: args.where.id }))
    };
    const { fieldPolicy, permission, role, rolePermission } = readyStandardIdentityCatalogMocks();
    const roleAssignment = {
      findFirst: vi.fn(() => Promise.resolve({ id: existingRoleAssignmentId })),
      create: vi.fn((args: RoleAssignmentCreateArgs) => {
        void args;
        return Promise.resolve({ id: "should-not-create" });
      })
    };
    const configRule = {
      findFirst: vi.fn((args: ConfigRuleFindFirstArgs) => {
        void args;
        return Promise.resolve({ id: existingConfigRuleId });
      }),
      create: vi.fn((args: ConfigRuleCreateArgs) => {
        void args;
        return Promise.resolve({ id: "should-not-create" });
      })
    };
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      person,
      userAccount,
      authCredential,
      permission,
      role,
      rolePermission,
      fieldPolicy,
      roleAssignment,
      configRule
    };
    const client: TenantTransactionRunner & { organization: typeof organization } = {
      organization,
      $transaction: (callback) => callback(tx as unknown as TenantTransaction)
    };

    await bootstrapFirstAdmin(client, {
      ADMIN_EMAIL: "Admin@Example.com",
      ADMIN_PASSWORD: "owner-entered replacement password"
    });

    expect(organization.upsert).not.toHaveBeenCalled();
    expect(person.upsert).not.toHaveBeenCalled();
    expect(userAccount.upsert).not.toHaveBeenCalled();
    expect(authCredential.update).not.toHaveBeenCalled();
    expect(authCredential.create).not.toHaveBeenCalled();
    expect(roleAssignment.findFirst).not.toHaveBeenCalled();
    expect(roleAssignment.create).not.toHaveBeenCalled();
    expect(configRule.create).not.toHaveBeenCalled();
  });
});
