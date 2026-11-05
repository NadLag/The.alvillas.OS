import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ensureStandardIdentitySetup, startTotpEnrollment, confirmTotpEnrollment } from "@/modules/identity/application/identity-service";
import { identityActorContextFromSession } from "@/modules/identity/application/identity-access";
import { authContextForAccount } from "@/platform/authz/account-context";
import { totpCode } from "@/platform/auth/totp";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import * as auditWriter from "@/platform/audit/audit-writer";
import { readPaymentMethodCatalog } from "@/modules/finance/application/payment-method-service";
import { paymentMethodPolicyKey, PaymentMethodAccessError, PaymentMethodChangedError, PaymentMethodConfigurationError } from "@/modules/finance/domain/payment-method";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_payment168_") || target.pathname.startsWith("/alvillas_automation_payment169_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned native payment admission database required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

const keys = ["config_rule:view", "financial_transaction:view", "cash_collection:view", "bank_statement:view"];
async function fixture(enroll = true) {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Actual isolated payment method acceptance", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const f = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Actual payment accountant" } }),
      account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id, email: "payment-" + randomUUID() + "@example.test", mfaRequired: true } }),
      role = await tx.role.create({ data: { organizationId: org, key: "actual_payment_reader", name: "Actual independent funding source access" } }),
      permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } });
    expect(permissions).toHaveLength(keys.length); await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, personId: person.id, userAccountId: account.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } }),
      labels = { en: "Actual received funds", fr: "Fonds reçus réels", ar: "أموال مستلمة فعلية" },
      policy = { methods: [{ key: "bank." + org, labels, enabled: true, adapter: "bank_transfer", currencies: ["MAD", "EUR"] },
        { key: "cash." + org, labels, enabled: true, adapter: "cash", currencies: ["MAD"] },
        { key: "disabled." + org, labels, enabled: false, adapter: "manual", currencies: ["MAD", "EUR"] }] },
      rules = new ConfigRuleRepository(tx, org), rule = await rules.createVersion({ key: paymentMethodPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
        createdBy: account.id, value: policy, reason: "Explicit actual payment method definitions and original funding source authority" });
    await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 }, reason: "Explicit actual original financial calendar" });
    const finance = new FinanceRepository(tx, org), bank = await finance.ensureLedgerAccount({ code: "ORIGINAL_PAYMENT_BANK", name: "Original custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
      income = await finance.ensureLedgerAccount({ code: "ORIGINAL_PAYMENT_INCOME", name: "Original ownership", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
    for (const [currency, amount] of [["MAD", "0.07"], ["EUR", "9007199254740993.07"]]) await finance.createFinancialTransaction({ reference: "ORIGINAL:" + currency, occurredAt: new Date("2020-05-02T12:00:00Z"),
      description: "Original immutable funding evidence", createdBy: account.id, idempotencyKey: randomUUID(), postings: [
        { ledgerAccountId: bank.id, side: "DEBIT", amount: Money.of(amount, currency), bucket: "COMPANY_REVENUE", dimensions: {} },
        { ledgerAccountId: income.id, side: "CREDIT", amount: Money.of(amount, currency), bucket: "COMPANY_REVENUE", dimensions: {} }] });
    return { org, person, account, role, grant, policy, rule };
  });
  if (enroll) {
    const ctx = await identityActorContextFromSession({ user: { id: f.account.id, personId: f.person.id, organizationId: org, preferredLocale: "en", sessionId: randomUUID(), sessionRevoked: false, securitySetupRequired: true }, expires: new Date(Date.now() + 3600000).toISOString() }, { db });
    if (!ctx) throw Error("Actual own-factor native enrollment required"); const pending = await startTotpEnrollment(ctx, { db }); await confirmTotpEnrollment(ctx, pending.credentialId, totpCode(pending.secret), { db });
  }
  return { ...f, ctx: { organizationId: org, actorId: f.account.id, authContext: { ...await authContextForAccount(org, f.account.id, { db }), personId: f.person.id } } };
}
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,body`);
const audits = (org: string) => withTenant(db, org, tx => tx.auditLog.count({ where: { action: "finance.payment_methods.read" } }));

describe("native original payment method catalog", () => {
  it("returns only enabled configured native-currency methods with retained version and unchanged original money", async () => {
    const f = await fixture(), original = await facts(f.org), catalog = await readPaymentMethodCatalog(f.ctx, { currency: "EUR" }, { db });
    expect(catalog.currency).toBe("EUR"); expect(catalog.policy).toEqual({ id: f.rule.id, version: f.rule.version }); expect(catalog.methods.map(method => method.key)).toEqual([f.policy.methods[0].key]);
    expect(JSON.stringify(catalog)).not.toContain("9007199254740993.07"); expect(await audits(f.org)).toBe(1); expect(await facts(f.org)).toEqual(original);
  });
  it("isolates actual tenant definitions and rejects an actor or organization substituted into an existing capability", async () => {
    const f = await fixture(), other = await fixture(), catalog = await readPaymentMethodCatalog(f.ctx, {}, { db });
    expect(catalog.methods.map(method => method.key)).toEqual(f.policy.methods.slice(0, 2).map(method => method.key)); expect(JSON.stringify(catalog)).not.toContain(other.org);
    await expect(readPaymentMethodCatalog({ ...f.ctx, organizationId: other.org }, {}, { db })).rejects.toThrow(PaymentMethodAccessError);
    await expect(readPaymentMethodCatalog({ ...f.ctx, actorId: other.account.id }, {}, { db })).rejects.toThrow(PaymentMethodAccessError); expect(await audits(other.org)).toBe(0);
  });
  it("intersects original held restrictions with current native grants before emitting choices", async () => {
    const f = await fixture(), restricted = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "bank_statement:view")) } };
    await expect(readPaymentMethodCatalog(restricted, {}, { db })).rejects.toThrow(PaymentMethodAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
    await expect(readPaymentMethodCatalog(f.ctx, {}, { db })).rejects.toThrow(PaymentMethodAccessError); expect(await audits(f.org)).toBe(0);
  });
  it("requires actual native MFA enrollment even when the caller presents every source permission", async () => {
    const f = await fixture(false), presented = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(keys) } };
    await expect(readPaymentMethodCatalog(presented, {}, { db })).rejects.toThrow(PaymentMethodAccessError); expect(await audits(f.org)).toBe(0);
  });
  it("refuses a configured currency without an actual supported native money reference", async () => {
    const f = await fixture(); await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: paymentMethodPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"),
      createdBy: f.account.id, value: { methods: [{ ...f.policy.methods[0], currencies: ["ZZZ"] }] }, reason: "Invalid actual currency definition admission probe" }));
    await expect(readPaymentMethodCatalog(f.ctx, {}, { db })).rejects.toThrow(PaymentMethodConfigurationError); expect(await audits(f.org)).toBe(0);
  });
  it("withholds choices and rolls back their audit after a concurrent policy replacement", async () => {
    const f = await fixture(), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.payment_methods.read") await withTenant(db, f.org, inner => new ConfigRuleRepository(inner, f.org).createVersion({ key: paymentMethodPolicyKey,
      scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: f.account.id, value: { methods: f.policy.methods.map(method => ({ ...method, enabled: false })) }, reason: "Concurrent independently committed payment method replacement" })); return saved; });
    await expect(readPaymentMethodCatalog(f.ctx, {}, { db })).rejects.toThrow(PaymentMethodChangedError); expect(await audits(f.org)).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("rechecks current funding authority after its audit and releases no choices after revocation", async () => {
    const f = await fixture(), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.payment_methods.read") await withTenant(db, f.org, inner => inner.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); return saved; });
    await expect(readPaymentMethodCatalog(f.ctx, {}, { db })).rejects.toThrow(PaymentMethodAccessError); expect(await audits(f.org)).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
});
