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
      upsert: vi.fn(() => Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000003" }))
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
});
