import { randomBytes } from "node:crypto";
import argon2 from "argon2";

export async function hashPassword(password: string, salt = randomBytes(16)): Promise<string> {
  if (password.length < 12) {
    throw new Error("Bootstrap password must be at least 12 characters");
  }

  return hashCredentialSecret(password, salt);
}

export async function hashCredentialSecret(secret: string, salt = randomBytes(16)): Promise<string> {
  return argon2.hash(secret, {
    type: argon2.argon2id,
    salt,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!encoded.startsWith("$argon2id$")) {
    return false;
  }

  return argon2.verify(encoded, password);
}
