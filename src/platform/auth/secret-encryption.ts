import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const devFallbackSecret = "dev-only-alvillas-os-auth-secret";

function activeKeyMaterial(env: NodeJS.ProcessEnv = process.env): { version: string; key: Buffer } {
  const configured = env.ENCRYPTION_KEYS?.split(",").map((entry) => entry.trim()).filter(Boolean)[0];
  const source = configured ?? env.AUTH_SECRET ?? (env.NODE_ENV === "production" ? undefined : devFallbackSecret);

  if (!source) {
    throw new Error("ENCRYPTION_KEYS is required for encrypted identity secrets");
  }

  const [versionCandidate, materialCandidate] = source.includes(":")
    ? source.split(":", 2)
    : ["v1", source];
  const material = materialCandidate ?? versionCandidate;
  const decoded = Buffer.from(material, "base64");
  const key = decoded.length === 32 ? decoded : createHash("sha256").update(material).digest();

  return {
    version: versionCandidate || "v1",
    key
  };
}

function keyForVersion(version: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.ENCRYPTION_KEYS?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];

  for (const entry of configured) {
    const [entryVersion, materialCandidate] = entry.includes(":") ? entry.split(":", 2) : ["v1", entry];

    if (entryVersion === version) {
      const decoded = Buffer.from(materialCandidate ?? entryVersion, "base64");

      return decoded.length === 32
        ? decoded
        : createHash("sha256").update(materialCandidate ?? entryVersion).digest();
    }
  }

  const active = activeKeyMaterial(env);

  if (active.version === version) {
    return active.key;
  }

  throw new Error("No matching ENCRYPTION_KEYS version for encrypted identity secret");
}

export function encryptSecret(plainText: string, env: NodeJS.ProcessEnv = process.env): string {
  const { version, key } = activeKeyMaterial(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    version,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(":");
}

export function decryptSecret(encrypted: string, env: NodeJS.ProcessEnv = process.env): string {
  const [version, ivText, tagText, ciphertextText] = encrypted.split(":");

  if (!version || !ivText || !tagText || !ciphertextText) {
    throw new Error("Encrypted identity secret has an invalid envelope");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyForVersion(version, env),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
