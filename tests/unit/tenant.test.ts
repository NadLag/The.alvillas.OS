import { describe, expect, it, vi } from "vitest";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";

describe("withTenant", () => {
  it("sets the PostgreSQL tenant session variable inside the transaction", async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = { $executeRaw: executeRaw };
    const db = {
      $transaction: vi.fn((callback: (value: unknown) => Promise<string>) => callback(tx))
    };

    const result = await withTenant(
      db as unknown as TenantTransactionRunner,
      "018f0a0b-0000-7000-9000-000000000001",
      (tenantTx) => {
        expect(tenantTx).toBe(tx);
        return Promise.resolve("ok");
      }
    );

    expect(result).toBe("ok");
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(executeRaw).toHaveBeenCalledOnce();
  });

  it("rejects non-UUID organization ids before opening a transaction", async () => {
    const db = {
      $transaction: vi.fn()
    };

    await expect(
      withTenant(db as unknown as TenantTransactionRunner, "org-a", () => Promise.resolve("never"))
    ).rejects.toThrow("organizationId must be a UUID");

    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
