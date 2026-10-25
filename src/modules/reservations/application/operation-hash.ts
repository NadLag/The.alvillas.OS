import { createHash } from "node:crypto";

export function operationHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
