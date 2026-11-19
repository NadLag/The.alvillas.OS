import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptBytes, decryptSecret, encryptBytes, encryptSecret, signBytes, verifyBytes } from "@/platform/auth/secret-encryption";

describe("versioned encryption rotation", () => {
  it("reads original ciphertext and signatures after rotating and rolling back the active version", () => {
    const old = "previous:" + randomBytes(32).toString("base64");
    const fresh = "next:" + randomBytes(32).toString("base64");
    const before = { ENCRYPTION_KEYS: old };
    const after = { ENCRYPTION_KEYS: `${fresh},${old}` };
    const rollback = { ENCRYPTION_KEYS: `${old},${fresh}` };
    const bytes = Buffer.from("retained document evidence");
    const context = "restore-rehearsal:original-artifact";
    const encrypted = encryptBytes(bytes, context, before);
    const signature = signBytes(bytes, context, before);

    expect(decryptBytes(encrypted, context, after)).toEqual(bytes);
    expect(verifyBytes(bytes, signature.signature, signature.version, context, after)).toBe(true);
    const newest = encryptSecret("new record", after);
    expect(newest.startsWith("next:")).toBe(true);
    expect(decryptSecret(newest, rollback)).toBe("new record");
    expect(() => decryptBytes(encrypted, context, { ENCRYPTION_KEYS: fresh })).toThrow();
  });
});
