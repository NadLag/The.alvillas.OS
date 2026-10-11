import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const modelPattern = /^model\s+(\w+)\s+\{([\s\S]*?)^\}/gmu;
const allowList = new Set(["Organization", "Currency"]);
const failures: string[] = [];
const tenantTables: string[] = [];

function sqlIdentifier(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tableName(modelName: string, body: string): string {
  const mapped = body.match(/@@map\("([^"]+)"\)/u)?.[1];
  return mapped ?? modelName.replace(/[A-Z]/gu, (letter, offset) =>
    `${offset === 0 ? "" : "_"}${letter.toLowerCase()}`
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

for (const match of schema.matchAll(modelPattern)) {
  const [, modelName, body] = match;

  if (allowList.has(modelName)) {
    continue;
  }

  if (!/^\s+organizationId\s+/mu.test(body)) {
    failures.push(`${modelName} lacks organizationId`);
  } else {
    tenantTables.push(tableName(modelName, body));
  }
}

const migrationSql = walk("prisma/migrations")
  .filter((path) => path.endsWith(".sql"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

for (const table of tenantTables) {
  const identifier = sqlIdentifier(table);
  const enableRls = new RegExp(`ALTER\\s+TABLE\\s+${identifier}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, "iu");
  const forceRls = new RegExp(`ALTER\\s+TABLE\\s+${identifier}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, "iu");
  const tenantPolicy = new RegExp(`CREATE\\s+POLICY\\s+${identifier}_tenant_isolation\\s+ON\\s+${identifier}`, "iu");

  if (!enableRls.test(migrationSql)) {
    failures.push(`${table} lacks ENABLE ROW LEVEL SECURITY migration`);
  }

  if (!forceRls.test(migrationSql)) {
    failures.push(`${table} lacks FORCE ROW LEVEL SECURITY migration`);
  }

  if (!tenantPolicy.test(migrationSql)) {
    failures.push(`${table} lacks tenant isolation policy migration`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("organization_id policy check ok");
