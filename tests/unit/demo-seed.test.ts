import { describe, expect, it, vi } from "vitest";
import { assertDemoSeedAllowed, demoOrganizationId, seedDemoData } from "../../prisma/seed";

describe("demo seed", () => {
  it("refuses to run in production", () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production" })).toThrow(
      "Demo seed cannot run in production"
    );
    expect(() => assertDemoSeedAllowed({ VERCEL_ENV: "production" })).toThrow(
      "Demo seed cannot run in production"
    );
  });

  it("uses deterministic organization identity", async () => {
    const upsert = vi.fn(() => Promise.resolve({}));

    await seedDemoData({ organization: { upsert } });

    expect(upsert).toHaveBeenCalledWith({
      where: { id: demoOrganizationId },
      update: { name: "ALVILLAS Demo", baseCurrency: "MAD" },
      create: { id: demoOrganizationId, name: "ALVILLAS Demo", baseCurrency: "MAD" }
    });
  });
});
