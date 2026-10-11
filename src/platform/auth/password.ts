import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const keyLength = 64;
type ScryptParams = { N: number; r: number; p: number };
const scryptOptions: ScryptParams = { N: 16384, r: 8, p: 1 };

function scrypt(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptParams
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string, salt = randomBytes(16)): Promise<string> {
  if (password.length < 12) {
    throw new Error("Bootstrap password must be at least 12 characters");
  }

  const hash = await scrypt(password, salt, keyLength, scryptOptions);

  return [
    "scrypt",
    "v1",
    `n=${scryptOptions.N}`,
    `r=${scryptOptions.r}`,
    `p=${scryptOptions.p}`,
    salt.toString("base64url"),
    hash.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, version, n, r, p, salt, stored] = encoded.split("$");

  if (algorithm !== "scrypt" || version !== "v1" || !n || !r || !p || !salt || !stored) {
    return false;
  }

  const options = {
    N: Number(n.replace("n=", "")),
    r: Number(r.replace("r=", "")),
    p: Number(p.replace("p=", ""))
  };
  const expected = Buffer.from(stored, "base64url");
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, options);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
