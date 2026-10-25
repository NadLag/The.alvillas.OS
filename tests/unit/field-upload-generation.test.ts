import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { temporaryUploadPartKey } from "@/platform/storage/upload-protocol";

describe("field upload generation storage isolation", () => {
  it("retains legacy keys while separating recovered parts from expired signatures and cleanup", () => {
    const part = { organizationId: randomUUID(), uploadId: randomUUID(), index: 0 };
    const legacy = `${part.organizationId}/uploads/${part.uploadId}/part-0`;
    expect(temporaryUploadPartKey(part)).toBe(legacy);
    expect(temporaryUploadPartKey({ ...part, generation: 1 })).toBe(legacy);
    expect(temporaryUploadPartKey({ ...part, generation: 2 })).toBe(`${part.organizationId}/uploads/${part.uploadId}/generation-2/part-0`);
    expect(temporaryUploadPartKey({ ...part, generation: 2 })).not.toBe(legacy);
  });
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects ambiguous or overflowing generations: %s", generation => {
    const part = { organizationId: randomUUID(), uploadId: randomUUID(), index: 0, generation };
    expect(() => temporaryUploadPartKey(part)).toThrow();
  });
});
