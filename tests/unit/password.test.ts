import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/platform/auth/password";

describe("password hashing", () => {
  it("rejects short bootstrap passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow("at least 12 characters");
  });

  it("verifies a scrypt password hash", async () => {
    const hash = await hashPassword("correct horse battery staple");

    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse battery staple", hash)).resolves.toBe(false);
  });
});
