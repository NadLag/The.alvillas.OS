import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { LedgerIntegrityRepository } from "@/modules/finance/infrastructure/ledger-integrity-repository";
import { scheduleLedgerIntegrity, LedgerIntegrityAccessError, LedgerIntegritySourceChangedError } from "@/modules/finance/application/ledger-integrity-service";
import { ledgerIntegrityPolicyKey } from "@/modules/finance/domain/ledger-integrity";
import { Money } from "@/platform/money/money";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_integrity166_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated native integrity acceptance database required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Actual retained nightly integrity", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Actual configured integrity principal" } }), account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } }),
      role = await tx.role.create({ data: { organizationId: org, key: "actual_integrity_reader", name: "Explicit complete integrity authority" } }),
      keys = [...new Set(["config_rule:configure", ...financialRuleSourceChecks(org, ledgerIntegrityPolicyKey).map(check => check.resource.type + ":" + check.action)])],
      permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } });
    expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, userAccountId: account.id, personId: person.id, scopeType: "organization", validFrom: new Date("2000-01-01") } }),
      rules = new ConfigRuleRepository(tx, org);
    await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 }, reason: "Explicit native integrity calendar" });
    const policy = await rules.createVersion({ key: ledgerIntegrityPolicyKey, scopeType: "organization", effectiveFrom: new Date("2000-01-01"), createdBy: account.id,
      value: { run_at: "00:00", page_size: 50, max_findings: 10, account_types: { locations: ["ASSET_LOCATION"], claims: ["CLAIM_OWNERSHIP"], company: ["ALVILLAS_OWN"] } }, reason: "Explicit native nightly integrity policy" }),
      finance = new FinanceRepository(tx, org), bank = await finance.ensureLedgerAccount({ code: "ORIGINAL_INTEGRITY_BANK", name: "Original custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
      income = await finance.ensureLedgerAccount({ code: "ORIGINAL_INTEGRITY_INCOME", name: "Original income", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
    for (const [currency, value] of [["MAD", "0.07"], ["EUR", "9007199254740993.07"]]) {
      const amount = Money.of(value, currency); await finance.createFinancialTransaction({ reference: "ORIGINAL:" + currency, description: "Original native integrity source", occurredAt: new Date("2020-05-02T12:00:00Z"), createdBy: account.id,
        idempotencyKey: randomUUID(), postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }, { ledgerAccountId: income.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }] });
    }
    return { org, account, grant, policy, bank, income };
  });
}
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);

describe("actual native nightly ledger integrity", () => {
  it("rebuilds exact currencies, retains verified source hashes and admits only one daily occurrence", async () => {
    const f = await fixture(), original = await facts(f.org), first = await scheduleLedgerIntegrity(f.org, { db });
    expect(first).toMatchObject({ configured: true, passed: true }); expect(first.runId).toBeTruthy();
    expect(await scheduleLedgerIntegrity(f.org, { db })).toEqual(first);
    const retained = await withTenant(db, f.org, async tx => ({ runs: await tx.ledgerIntegrityRun.findMany(), sources: await tx.ledgerIntegritySource.findMany(), audits: await tx.auditLog.count({ where: { action: "finance.ledger_integrity.passed" } }) }));
    expect(retained.runs).toHaveLength(1); expect(retained.sources).toHaveLength(2); expect(retained.audits).toBe(1);
    expect(retained.runs[0].report).toMatchObject({ passed: true, movements: "4", failureCount: "0", currencies: [
      { currency: "EUR", locations: "9007199254740993.07", claims: "0.00", company: "9007199254740993.07" }, { currency: "MAD", locations: "0.07", claims: "0.00", company: "0.07" }] });
    expect(await facts(f.org)).toEqual(original);
  });
  it("deduplicates concurrent native admissions without duplicate audit or financial writes", async () => {
    const f = await fixture(), original = await facts(f.org), results = await Promise.all([scheduleLedgerIntegrity(f.org, { db }), scheduleLedgerIntegrity(f.org, { db })]);
    expect(results[0]).toEqual(results[1]); expect(results[0].passed).toBe(true);
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(1); expect(await facts(f.org)).toEqual(original);
  });
  it("enforces tenant isolation for native receipts and source hashes", async () => {
    const a = await fixture(), b = await fixture(); await scheduleLedgerIntegrity(b.org, { db });
    expect(await withTenant(db, a.org, tx => tx.ledgerIntegrityRun.findMany({ where: { organizationId: b.org } }))).toEqual([]);
    expect(await withTenant(db, a.org, tx => tx.ledgerIntegritySource.findMany({ where: { organizationId: b.org } }))).toEqual([]);
    const source = await withTenant(db, b.org, tx => tx.ledgerIntegritySource.findFirstOrThrow());
    await expect(withTenant(db, a.org, tx => tx.ledgerIntegritySource.create({ data: { organizationId: b.org, transactionId: source.transactionId, fingerprint: source.fingerprint } }))).rejects.toThrow();
  });
  it("rejects forged baselines and retains append-only native verification history", async () => {
    const f = await fixture(), original = await facts(f.org), journal = await withTenant(db, f.org, tx => tx.financialTransaction.findFirstOrThrow());
    await expect(withTenant(db, f.org, tx => tx.ledgerIntegritySource.create({ data: { organizationId: f.org, transactionId: journal.id, fingerprint: "0".repeat(64) } }))).rejects.toThrow(/baseline must match/);
    const result = await scheduleLedgerIntegrity(f.org, { db });
    const metadata = () => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
      SELECT 'run' AS kind,id::text,xmin::text,to_jsonb(r)::text AS body FROM ledger_integrity_run r WHERE organization_id=${f.org}::uuid
      UNION ALL SELECT 'source',transaction_id::text,xmin::text,to_jsonb(s)::text FROM ledger_integrity_source s WHERE organization_id=${f.org}::uuid ORDER BY kind,id`), before = await metadata();
    await expect(withTenant(db, f.org, tx => tx.ledgerIntegrityRun.update({ where: { id: result.runId! }, data: { passed: false } }))).rejects.toThrow(/ledger rows are append-only/);
    await expect(withTenant(db, f.org, tx => tx.ledgerIntegritySource.update({ where: { organizationId_transactionId: { organizationId: f.org, transactionId: journal.id } }, data: { fingerprint: "0".repeat(64) } }))).rejects.toThrow(/ledger rows are append-only/);
    expect(await metadata()).toEqual(before);
    expect(await facts(f.org)).toEqual(original);
  });
  it("rolls back receipts, baselines and audit when the configured principal is revoked after recording", async () => {
    const f = await fixture(), original = await facts(f.org), method = Object.getOwnPropertyDescriptor(LedgerIntegrityRepository.prototype, "record")!.value as LedgerIntegrityRepository["record"],
      spy = vi.spyOn(LedgerIntegrityRepository.prototype, "record").mockImplementation(async function (this: LedgerIntegrityRepository, input) {
        const result = await method.call(this, input); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); return result;
      });
    try { await expect(scheduleLedgerIntegrity(f.org, { db })).rejects.toBeInstanceOf(LedgerIntegrityAccessError); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(0); expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: { startsWith: "finance.ledger_integrity." } } }))).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("retains a real failed receipt for a mismatched independent total without changing source money", async () => {
    const f = await fixture(), original = await facts(f.org), method = Object.getOwnPropertyDescriptor(LedgerIntegrityRepository.prototype, "accounts")!.value as LedgerIntegrityRepository["accounts"],
      spy = vi.spyOn(LedgerIntegrityRepository.prototype, "accounts").mockImplementation(async function (this: LedgerIntegrityRepository) {
        const rows = await method.call(this); return rows.map((row, index) => index ? row : { ...row, debits: Money.of(row.debits, row.currency).add(Money.of("0.01", row.currency)).toJSON().amount });
      });
    let runId: string | null;
    try { const result = await scheduleLedgerIntegrity(f.org, { db }); expect(result.passed).toBe(false); runId = result.runId; } finally { spy.mockRestore(); }
    const row = await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: runId! } }));
    expect(row.report).toMatchObject({ passed: false, failureCount: "1", findings: [{ code: "ACCOUNT_BALANCE" }] });
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("rejects a changed final native snapshot before any retained result escapes", async () => {
    const f = await fixture(), original = await facts(f.org), spy = vi.spyOn(LedgerIntegrityRepository.prototype, "snapshotMatches").mockResolvedValue(false);
    try { await expect(scheduleLedgerIntegrity(f.org, { db })).rejects.toBeInstanceOf(LedgerIntegritySourceChangedError); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.count())).toBe(0); expect(await facts(f.org)).toEqual(original);
  });
  it("does not fabricate a nightly policy or a financial principal for an unconfigured tenant", async () => {
    const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Explicitly unconfigured integrity tenant", baseCurrency: "MAD" } });
    expect(await scheduleLedgerIntegrity(org, { db })).toEqual({ configured: false, runId: null, passed: null });
    expect(await withTenant(db, org, tx => tx.ledgerIntegrityRun.count())).toBe(0);
  });
  it("checks every original movement across 500 real properties with exact large cents and retained history", async () => {
    const f = await fixture(), properties = Array.from({ length: 500 }, () => ({ id: randomUUID(), organizationId: f.org, name: "Actual integrity villa", addressLine1: "Native acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [] as string[], photoUrls: [] as string[] }));
    await withTenant(db, f.org, async tx => {
      await tx.property.createMany({ data: properties }); const finance = new FinanceRepository(tx, f.org), amount = Money.of("9007199254740993.07", "EUR");
      for (const property of properties) await finance.createFinancialTransaction({ reference: "ACTUAL-500:" + property.id, description: "Actual large native source across 500 properties", occurredAt: new Date("2020-05-03T12:00:00Z"), createdBy: f.account.id, idempotencyKey: randomUUID(),
        postings: [{ ledgerAccountId: f.bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions: { property_id: property.id } }, { ledgerAccountId: f.income.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions: { property_id: property.id } }] });
    });
    const original = await facts(f.org), result = await scheduleLedgerIntegrity(f.org, { db }); expect(result.passed).toBe(true);
    const receipt = await withTenant(db, f.org, tx => tx.ledgerIntegrityRun.findUniqueOrThrow({ where: { id: result.runId! } }));
    expect(receipt.report).toMatchObject({ movements: "1004", failureCount: "0", currencies: [{ currency: "EUR", locations: Money.of("9007199254740993.07", "EUR").multiply("501").toJSON().amount }, { currency: "MAD", locations: "0.07" }] });
    expect(await withTenant(db, f.org, tx => tx.ledgerIntegritySource.count())).toBe(502); expect(await facts(f.org)).toEqual(original);
  });
});
