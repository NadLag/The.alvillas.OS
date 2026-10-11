import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const failures: string[] = [];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const migrationSql = walk("prisma/migrations")
  .filter((path) => path.endsWith(".sql"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

for (const required of [
  "CREATE TABLE ledger_account",
  "CREATE TABLE financial_transaction",
  "CREATE TABLE posting",
  "app_prevent_ledger_mutation",
  "app_assert_financial_transaction_balanced",
  "DEFERRABLE INITIALLY DEFERRED",
  "posting_positive_amount",
  "posting_organization_consistency"
]) {
  if (!migrationSql.includes(required)) {
    failures.push(`ledger migration missing ${required}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("ledger migration check ok");
