import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { requiredAuditCategories } from "../../src/platform/audit/audit-event";

const failures: string[] = [];
const schema = readFileSync("prisma/schema.prisma", "utf8");
const auditModel = schema.match(/^model\s+AuditLog\s+\{([\s\S]*?)^\}/mu)?.[1] ?? "";

for (const field of [
  "organizationId",
  "actorId",
  "action",
  "resourceType",
  "resourceId",
  "ipAddress",
  "deviceId",
  "propertyScopeId",
  "before",
  "after",
  "reason",
  "requestId",
  "occurredAt"
]) {
  if (!new RegExp(`^\\s+${field}\\s+`, "mu").test(auditModel)) {
    failures.push(`AuditLog missing ${field}`);
  }
}

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
  "CREATE TABLE audit_log",
  "app_prevent_audit_log_mutation",
  "CREATE TRIGGER audit_log_no_update",
  "CREATE TRIGGER audit_log_no_delete",
  "REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC"
]) {
  if (!migrationSql.includes(required)) {
    failures.push(`audit migration missing ${required}`);
  }
}

for (const category of [
  "permission_change",
  "role_assignment",
  "financial_edit",
  "payout",
  "approval",
  "proxy_validation",
  "agreement_change",
  "expense_modification",
  "wallet_adjustment",
  "bank_reconciliation",
  "report_generation",
  "account_access"
]) {
  if (!(requiredAuditCategories as readonly string[]).includes(category)) {
    failures.push(`audit event catalog missing ${category}`);
  }
}

const auditWriterSource = readFileSync("src/platform/audit/audit-writer.ts", "utf8");
const auditServiceSource = readFileSync("src/modules/audit/application/audit-service.ts", "utf8");

for (const requiredSource of [
  "redactAuditPayload",
  "auditActionRequiresReason",
  "AuditAuthorizationError",
  "exportAuditRecords"
]) {
  if (!auditWriterSource.includes(requiredSource) && !auditServiceSource.includes(requiredSource)) {
    failures.push(`audit source missing ${requiredSource}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("audit migration check ok");
