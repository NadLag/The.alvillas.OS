import { describe, expect, it, vi } from "vitest";
import {
  assertDemoSeedAllowed,
  demoOrganizationId,
  demoOwnerId,
  demoPropertyId,
  seedDemoData
} from "../../prisma/seed";

describe("demo seed", () => {
  it("refuses to run in production", () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production" })).toThrow(
      "Demo seed cannot run in production"
    );
    expect(() => assertDemoSeedAllowed({ VERCEL_ENV: "production" })).toThrow(
      "Demo seed cannot run in production"
    );
  });

  it("uses deterministic organization and business identities", async () => {
    const organizationUpsert = vi.fn(() => Promise.resolve({ id: demoOrganizationId }));
    const ownerUpsert = vi.fn(() => Promise.resolve({ id: demoOwnerId }));
    const propertyUpsert = vi.fn(() => Promise.resolve({ id: demoPropertyId }));
    const reservationUpsert = vi.fn(() =>
      Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000103" })
    );
    const taskUpsert = vi.fn(() => Promise.resolve({ id: "018f0a0b-0000-7000-9000-000000000104" }));
    const ledgerAccountUpsert = vi
      .fn()
      .mockResolvedValueOnce({ id: "018f0a0b-0000-7000-9000-000000000201" })
      .mockResolvedValueOnce({ id: "018f0a0b-0000-7000-9000-000000000202" });
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      owner: {
        upsert: ownerUpsert,
        count: vi.fn(() => Promise.resolve(1))
      },
      property: {
        upsert: propertyUpsert,
        count: vi.fn(() => Promise.resolve(1))
      },
      propertyOwner: {
        upsert: vi.fn(() => Promise.resolve({}))
      },
      reservation: {
        upsert: reservationUpsert,
        count: vi.fn(() => Promise.resolve(1))
      },
      operationTask: {
        upsert: taskUpsert,
        count: vi.fn(() => Promise.resolve(1))
      },
      operationTaskChecklistItem: {
        upsert: vi.fn(() => Promise.resolve({}))
      },
      ledgerAccount: {
        upsert: ledgerAccountUpsert
      },
      financialTransaction: {
        upsert: vi.fn(() => Promise.resolve({})),
        count: vi.fn(() => Promise.resolve(1))
      },
      configRule: {
        findFirst: vi.fn(() => Promise.resolve(null)),
        update: vi.fn(() => Promise.resolve({})),
        create: vi.fn(() => Promise.resolve({}))
      }
    };
    const transaction = <T>(callback: (txInput: typeof tx) => Promise<T>): Promise<T> =>
      callback(tx);
    const client = {
      organization: { upsert: organizationUpsert },
      $transaction: transaction
    };

    await expect(seedDemoData(client as never)).resolves.toMatchObject({
      organizationId: demoOrganizationId,
      owners: 1,
      properties: 1,
      reservations: 1,
      tasks: 1,
      ledgerTransactions: 1,
      localizedPaths: 4
    });

    expect(organizationUpsert).toHaveBeenCalledWith({
      where: { id: demoOrganizationId },
      update: { name: "ALVILLAS Demo", baseCurrency: "MAD" },
      create: { id: demoOrganizationId, name: "ALVILLAS Demo", baseCurrency: "MAD" }
    });
    const ownerCalls = ownerUpsert.mock.calls as unknown as Array<[{ where?: { id?: string } }]>;
    const propertyCalls = propertyUpsert.mock.calls as unknown as Array<[{ where?: { id?: string } }]>;
    const ownerArgs = ownerCalls[0]?.[0];
    const propertyArgs = propertyCalls[0]?.[0];

    expect(ownerArgs?.where?.id).toBe(demoOwnerId);
    expect(propertyArgs?.where?.id).toBe(demoPropertyId);
    expect(tx.operationTaskChecklistItem.upsert).toHaveBeenCalledTimes(2);
    const transactionCalls = tx.financialTransaction.upsert.mock.calls as unknown as Array<[
      {
        where?: {
          organizationId_idempotencyKey?: {
            organizationId?: string;
            idempotencyKey?: string;
          };
        };
      }
    ]>;
    const transactionArgs = transactionCalls[0]?.[0] as
      | {
          where?: {
            organizationId_idempotencyKey?: {
              organizationId?: string;
              idempotencyKey?: string;
            };
          };
        }
      | undefined;
    const configRuleCalls = tx.configRule.create.mock.calls as unknown as Array<[
      {
        data?: {
          key?: string;
          value?: { paths?: Array<{ key?: string; en?: string; fr?: string }> };
        };
      }
    ]>;
    const configRuleArgs = configRuleCalls[0]?.[0] as
      | {
          data?: {
            key?: string;
            value?: { paths?: Array<{ key?: string; en?: string; fr?: string }> };
          };
        }
      | undefined;

    expect(transactionArgs?.where?.organizationId_idempotencyKey).toEqual({
      organizationId: demoOrganizationId,
      idempotencyKey: "demo-owner-opening-balance"
    });
    expect(configRuleArgs?.data?.key).toBe("demo.localized_paths");
    expect(configRuleArgs?.data?.value?.paths).toContainEqual({
      key: "owners",
      en: "/en/app/owners",
      fr: "/fr/app/owners"
    });
  });
});
