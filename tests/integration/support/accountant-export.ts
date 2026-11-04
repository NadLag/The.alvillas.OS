import { authContextForAccount } from "@/platform/authz/account-context";
import { accountantExportAuthorityChecks } from "@/platform/authz/accountant-export-resource";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { accountantExportPolicyKey } from "@/modules/finance/domain/accountant-export-policy";
import type { AccountantReportKind } from "@/modules/finance/domain/accountant-export";

export async function accountantExportFixtureAuthority(db: TenantTransactionRunner, source: { org: string; person?: { id: string }; account: { id: string; personId?: string | null } }, reports: AccountantReportKind[]) {
  const personId = source.person?.id ?? source.account.personId; if (!personId) throw Error("Actual source account person required");
  await withTenant(db, source.org, async tx => {
    const checks = accountantExportAuthorityChecks(source.org), keys = [...new Set(checks.map(check => check.resource.type + ":" + check.action))];
    const permissions = await tx.permission.findMany({ where: { organizationId: source.org, key: { in: keys } } });
    if (permissions.length !== keys.length) throw Error("Every independent native source permission must exist");
    const role = await tx.role.create({ data: { organizationId: source.org, key: "actual_accountant_" + crypto.randomUUID(), name: "Actual complete accountant source export authority",
      rolePermissions: { create: permissions.map(permission => ({ organizationId: source.org, permissionId: permission.id })) } } });
    await tx.roleAssignment.create({ data: { organizationId: source.org, roleId: role.id, personId, userAccountId: source.account.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
    await tx.organizationProfile.upsert({ where: { organizationId: source.org }, update: {}, create: { organizationId: source.org, brandName: "Actual native accountant source export", timezone: "UTC" } });
    await new ConfigRuleRepository(tx, source.org).createVersion({ key: accountantExportPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      value: { source: "ORIGINAL_POSTED_FINANCIAL_SOURCES", reports, formats: ["CSV", "EXCEL", "PDF"], classifications: {}, capacity: { CSV: 100, EXCEL: 100, PDF: 20 }, rate_limit: { requests: 20, window_seconds: 3600 } },
      createdBy: source.account.id, reason: "Explicit complete native accountant export policy and independent original source authority" });
  });
  return { organizationId: source.org, actorId: source.account.id, authContext: { ...await authContextForAccount(source.org, source.account.id, { db }), personId } };
}
