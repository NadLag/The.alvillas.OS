import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const messagesDir = join(process.cwd(), "messages");
const files = readdirSync(messagesDir)
  .filter((file) => file.endsWith(".json"))
  .sort();

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flattenKeys(child, prefix ? `${prefix}.${key}` : key)
    );
  }

  return [prefix];
}

const catalogs = new Map<string, Set<string>>();

for (const file of files) {
  const raw = readFileSync(join(messagesDir, file), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  catalogs.set(file, new Set(flattenKeys(parsed)));
}

const [referenceFile, referenceKeys] = catalogs.entries().next().value as [string, Set<string>];
const failures: string[] = [];

for (const [file, keys] of catalogs) {
  for (const key of referenceKeys) {
    if (!keys.has(key)) {
      failures.push(`${file} missing ${key} from ${referenceFile}`);
    }
  }

  for (const key of keys) {
    if (!referenceKeys.has(key)) {
      failures.push(`${file} has extra key ${key}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`i18n key parity ok for ${files.length} catalogs`);
