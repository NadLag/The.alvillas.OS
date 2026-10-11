import { describe, expect, it, vi } from "vitest";
import {
  formatReferenceNumber,
  nextReferenceNumber,
  type ReferenceNumberClient
} from "@/platform/references/reference-number";

describe("reference numbers", () => {
  it("formats per-organization references with stable zero padding", () => {
    expect(formatReferenceNumber("RES", 184n, 4)).toBe("RES-0184");
  });

  it("rejects unsafe prefixes", () => {
    expect(() => formatReferenceNumber("res", 1n)).toThrow(
      "reference prefix must be uppercase alphanumeric text"
    );
  });

  it("allocates the next value through an atomic database upsert", async () => {
    const queryRaw = vi.fn(() => Promise.resolve([{ value: 42n, width: 5 }]));
    const client = { $queryRaw: queryRaw } satisfies ReferenceNumberClient;

    await expect(
      nextReferenceNumber(client, "018f0a0b-0000-7000-9000-000000000001", "PAY", 5)
    ).resolves.toBe("PAY-00042");

    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it("fails closed if the allocator does not return a row", async () => {
    const client = {
      $queryRaw: vi.fn(() => Promise.resolve([]))
    } satisfies ReferenceNumberClient;

    await expect(
      nextReferenceNumber(client, "018f0a0b-0000-7000-9000-000000000001", "DOC")
    ).rejects.toThrow("reference sequence allocation returned no value");
  });
});
