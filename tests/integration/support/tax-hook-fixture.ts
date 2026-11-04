import type { PrismaClient } from "@prisma/client";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { actualGuestDepositFixture } from "./guest-deposit-fixture";

/** Configured fixture values exercise interfaces; they assert no country treatment or liability. */
export async function actualTaxHookFixture(db: PrismaClient, admin: PrismaClient) {
  const f = await actualGuestDepositFixture(db, admin);
  const value = { taxes: [{ key: "fixture_explicit_policy", amount: "0.07", rate_bps: 725, currency: "MAD", tax_hook: {
    category: { key: "fixture_category", labels: { en: "Configured fixture category", fr: "Catégorie de test configurée", ar: "فئة اختبار معدة" } },
    contexts: [{ kind: "PROPERTY", properties: { mode: "SELECTED", ids: [f.property.id] } },
      { kind: "SERVICE", properties: { mode: "ANY" }, services: { mode: "SELECTED", keys: ["fixture_service"] } },
      { kind: "TRANSACTION", properties: { mode: "COMPANY" }, transactionTypes: { mode: "SELECTED", keys: ["fixture_transaction"] } }]
  } }] };
  const policy = await withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["config_rule:view", "financial_transaction:view", "company_ledger:view", "audit_log:view"] } } });
    if (permissions.length !== 4) throw Error("Original independent tax/config/source permissions required");
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })), skipDuplicates: true });
    return new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.tax", scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      value, createdBy: f.account.id, reason: "Explicit fixture policy for deferred country-neutral tax interfaces" });
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
  return { ...f, ctx, policy, value };
}
