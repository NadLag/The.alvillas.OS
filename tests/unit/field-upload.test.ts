import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldUploadChunkBytes, fieldUploadManifestSchema, fieldUploadMaximumParts, fieldUploadPartStorageKey } from "@/modules/reservations/domain/field-upload";

function manifest(size: number) {
  return { protocolVersion: 1, localId: randomUUID(), taskId: randomUUID(), contentType: "image/jpeg", note: "Task evidence",
    size, sha256: "a".repeat(64), parts: Array.from({ length: Math.ceil(size / fieldUploadChunkBytes) }, (_, index) => ({
      sha256: "b".repeat(64), size: Math.min(fieldUploadChunkBytes, size - index * fieldUploadChunkBytes) })) };
}
describe("resumable field photo manifest", () => {
  it("canonicalizes UUID casing before recording immutable provenance", () => {
    const value = manifest(1); expect(fieldUploadManifestSchema.parse({ ...value, localId: value.localId.toUpperCase(), taskId: value.taskId.toUpperCase() }))
      .toEqual(fieldUploadManifestSchema.parse(value));
  });
  it("frames single-byte, exact-chunk and multi-chunk images without gaps", () => {
    for (const size of [1, fieldUploadChunkBytes - 1, fieldUploadChunkBytes, fieldUploadChunkBytes + 1, 3000000, 4000000])
      expect(fieldUploadManifestSchema.parse(manifest(size)).parts.reduce((total, part) => total + part.size, 0)).toBe(size);
  });
  it("rejects missing, extra and short non-final parts", () => {
    const value = manifest(fieldUploadChunkBytes + 1);
    for (const parts of [value.parts.slice(0, 1), [...value.parts, value.parts[1]], [{ ...value.parts[0], size: 1 }, value.parts[1]]])
      expect(fieldUploadManifestSchema.safeParse({ ...value, parts }).success).toBe(false);
  });
  it("rejects unsupported media, invalid digests, zero bytes and protocol extensions", () => {
    for (const changes of [{ contentType: "image/svg+xml" }, { sha256: "a".repeat(63) }, { sha256: "A".repeat(64) },
      { size: 0 }, { size: 4000001 }, { protocolVersion: 2 }, { actorId: randomUUID() }, { note: "" }])
      expect(fieldUploadManifestSchema.safeParse({ ...manifest(1), ...changes }).success).toBe(false);
  });
  it("bounds oversized manifests before visiting hostile entries", () => {
    const parts = new Array(fieldUploadMaximumParts + 1).fill(null);
    Object.defineProperty(parts, 0, { get: () => { throw new Error("entry must not be read"); } });
    expect(fieldUploadManifestSchema.safeParse({ ...manifest(1), parts }).success).toBe(false);
  });
  it("keeps temporary objects within the authenticated tenant and upload namespace", () => {
    const org = randomUUID(), upload = randomUUID(); expect(fieldUploadPartStorageKey(org, upload, 0)).toBe(`${org}/uploads/${upload}/part-0`);
    for (const index of [-1, 0.5, fieldUploadMaximumParts]) expect(() => fieldUploadPartStorageKey(org, upload, index)).toThrow();
    expect(() => fieldUploadPartStorageKey(`${org}/../another`, upload, 0)).toThrow();
    expect(() => fieldUploadPartStorageKey(org, "../../financial-document", 0)).toThrow();
  });
});
