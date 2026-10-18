import { describe, expect, it } from "vitest";
import { decryptBytes, encryptBytes } from "@/platform/auth/secret-encryption";

const oldKey = "old:isolated-binary-old-key";
const newKey = "new:isolated-binary-new-key";
const testEnv = (keys: string): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ENCRYPTION_KEYS: keys });
const context = JSON.stringify([
  "staff-document-v1",
  "tenant-a",
  "person-a",
  "object-a",
  "application/pdf",
  5
]);

describe("versioned binary encryption", () => {
  it("round-trips arbitrary bytes with independent nonces and authenticates record context", () => {
    const bytes = Buffer.from([0, 255, 10, 128, 42]);
    const env = testEnv(oldKey);
    const encrypted = encryptBytes(bytes, context, env);
    expect(encryptBytes(bytes, context, env)).not.toEqual(encrypted);
    expect(decryptBytes(encrypted, context, env)).toEqual(bytes);
    for (const field of ["tenant-a", "person-a", "object-a", "application/pdf"])
      expect(() => decryptBytes(encrypted, context.replace(field, "different"), env)).toThrow();
    encrypted[encrypted.length - 1] ^= 1;
    expect(() => decryptBytes(encrypted, context, env)).toThrow();
  });

  it("keeps earlier files readable after rotation while encrypting with the active key", () => {
    const bytes = Buffer.from("private staff document");
    const encrypted = encryptBytes(bytes, context, testEnv(oldKey));
    const rotated = testEnv(`${newKey},${oldKey}`);
    expect(decryptBytes(encrypted, context, rotated)).toEqual(bytes);
    expect(encryptBytes(bytes, context, rotated).subarray(0, 64).toString()).toContain(":new:");
    expect(() => decryptBytes(encrypted, context, testEnv(newKey))).toThrow();
  });

  it.each([
    Buffer.from("%PDF-plain"),
    Buffer.alloc(1000, 65),
    Buffer.from("alvillas-binary-v1:v1:x:y\n")
  ])("rejects malformed or plaintext storage objects", (bytes) => {
      expect(() => decryptBytes(bytes, context, testEnv(oldKey))).toThrow();
  });
});
