import { describe, expect, it, vi } from "vitest";
import { bootstrapFirstAdmin, bootstrapOrganizationId } from "../../prisma/bootstrap-admin";
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
    const permission = {
      upsert: vi.fn((args: { where: { organizationId_key: { key: string } } }) =>
        Promise.resolve({
          id: `permission-${args.where.organizationId_key.key}`
        })
      )
    };
    const role = {
      upsert: vi.fn((args: { where: { organizationId_key: { key: string } } }) =>
        Promise.resolve({
          id: `role-${args.where.organizationId_key.key}`
        })
      ),
      findFirst: vi.fn(() => Promise.resolve({ id: "role-admin", key: "admin" }))
    };
    const rolePermission = {
      upsert: vi.fn(() => Promise.resolve({}))
    };
    const fieldPolicy = {
      upsert: vi.fn(() => Promise.resolve({}))
    };
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

  it("updates an existing administrator without duplicating credentials, roles, or config", async () => {
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
    const permission = {
      upsert: vi.fn((args: { where: { organizationId_key: { key: string } } }) =>
        Promise.resolve({
          id: `permission-${args.where.organizationId_key.key}`
        })
      )
    };
    const role = {
      upsert: vi.fn((args: { where: { organizationId_key: { key: string } } }) =>
        Promise.resolve({
          id: `role-${args.where.organizationId_key.key}`
        })
      ),
      findFirst: vi.fn(() => Promise.resolve({ id: "role-admin", key: "admin" }))
    };
    const rolePermission = {
      upsert: vi.fn(() => Promise.resolve({}))
    };
    const fieldPolicy = {
      upsert: vi.fn(() => Promise.resolve({}))
    };
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

    const userAccountUpsertArgs = userAccount.upsert.mock.calls[0]?.[0];
    expect(userAccountUpsertArgs?.update).toMatchObject({
      personId: "018f0a0b-0000-7000-9000-000000000002",
      status: "ACTIVE"
    });
    expect(authCredential.update).toHaveBeenCalledOnce();
    expect(authCredential.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: existingPasswordCredentialId },
      data: { label: "Password" }
    });
    expect(authCredential.create).not.toHaveBeenCalled();
    expect(roleAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: bootstrapOrganizationId,
        personId: "018f0a0b-0000-7000-9000-000000000002",
        userAccountId: "018f0a0b-0000-7000-9000-000000000003",
        roleId: "role-admin",
        scopeType: "organization",
        scopeId: null,
        validTo: null,
        archivedAt: null
      },
      select: { id: true }
    });
    expect(roleAssignment.create).not.toHaveBeenCalled();
    expect(configRule.create).not.toHaveBeenCalled();
  });
});
