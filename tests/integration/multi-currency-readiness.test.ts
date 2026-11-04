import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { BankReconciliationRepository } from "@/modules/finance/infrastructure/bank-reconciliation-repository";
import { matchBankStatement, reviewBankReconciliation } from "@/modules/finance/application/bank-reconciliation-service";
import { getCompanyLedger, CompanyLedgerConfigurationError } from "@/modules/finance/application/company-ledger-service";
import { CompanyLedgerRepository } from "@/modules/finance/infrastructure/company-ledger-repository";
import { Money } from "@/platform/money/money";
import { actualBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_currency165_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated native currency acceptance database required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await admin.currency.upsert({ where: { code: "EUR" }, update: {}, create: { code: "EUR", name: "Euro", minorUnit: 2 } });
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });
type Fixture = Awaited<ReturnType<typeof actualBankReconciliationFixture>>;
async function command(f: Fixture) {
  const input = { action: "MATCH" as const, accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.07" }],
    actual: f.lines.map(line => ({ id: line.id, amount: line.amount!.toFixed(2) })), reason: "Retain original native currency without conversion", varianceAction: null };
  return { ...input, idempotencyKey: randomUUID(), reviewFingerprint: String((await reviewBankReconciliation(f.ctx, input, f.deps)).reviewFingerprint) };
}
const originalFacts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<{ kind: string; id: string; xmin: string; body: string }[]>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'bank',id::text,xmin::text,to_jsonb(l)::text FROM bank_statement_line l WHERE organization_id=${org}::uuid ORDER BY kind,id`);

describe("native financial currency boundaries", () => {
  it("stores an explicit source currency beside every new bank allocation without changing original money", async () => {
    const f = await actualBankReconciliationFixture(db, admin), before = await originalFacts(f.org);
    await matchBankStatement(f.ctx, await command(f), f.deps);
    const rows = await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.findMany());
    expect(rows).toHaveLength(2); expect(rows.every(row => row.currency === "MAD" && row.amount.toFixed(2) === "0.07")).toBe(true);
    expect(await originalFacts(f.org)).toEqual(before);
  });
  it("rejects a different registered allocation currency at the database boundary", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f), before = await originalFacts(f.org),
      original = Object.getOwnPropertyDescriptor(BankReconciliationRepository.prototype, "allocate")!.value as BankReconciliationRepository["allocate"],
      spy = vi.spyOn(BankReconciliationRepository.prototype, "allocate").mockImplementation(function (this: BankReconciliationRepository, entryId, rows) {
        return original.call(this, entryId, rows.map(row => ({ ...row, currency: "EUR" })));
      });
    try { await expect(matchBankStatement(f.ctx, input, f.deps)).rejects.toThrow(/entry_currency/); }
    finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(0);
    expect(await originalFacts(f.org)).toEqual(before);
  });
  it("binds currency to the same tenant's original reconciliation entry", async () => {
    const f = await actualBankReconciliationFixture(db, admin), foreign = await actualBankReconciliationFixture(db, admin);
    await matchBankStatement(f.ctx, await command(f), f.deps);
    const source = await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.findFirstOrThrow({ where: { postingId: f.posting.id } }));
    await expect(withTenant(db, foreign.org, tx => tx.bankReconciliationAllocation.create({ data: { organizationId: foreign.org, entryId: source.entryId,
      postingId: foreign.posting.id, originalAmount: source.originalAmount, allocatedBefore: source.allocatedBefore, amount: source.amount, currency: source.currency, sourceSnapshot: {} } }))).rejects.toThrow(/entry_currency/);
    expect(await withTenant(db, foreign.org, tx => tx.bankReconciliationAllocation.count())).toBe(0);
  });
  it("refuses automatic legacy currency enrichment before any retained financial record changes", async () => {
    const f = await actualBankReconciliationFixture(db, admin); await matchBankStatement(f.ctx, await command(f), f.deps);
    const before = await originalFacts(f.org), allocations = await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.findMany({ orderBy: { id: "asc" } }));
    const attempted = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "execute", "--file", "prisma/migrations/20261104204500_explicit_allocation_currency/migration.sql", "--url", url!],
      { env: process.env, encoding: "utf8", stdio: "pipe", windowsHide: true });
    expect(attempted.status).not.toBe(0); expect(attempted.stderr).toContain("legacy allocation currency enrichment requires owner review");
    expect(await originalFacts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.findMany({ orderBy: { id: "asc" } }))).toEqual(allocations);
  });
  it("keeps exact company ledgers separate in two native currencies while the organization base remains MAD", async () => {
    const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Actual separated currency ledgers", baseCurrency: "MAD" } });
    await ensureStandardIdentitySetup(org, { db });
    const identity = await withTenant(db, org, async tx => {
      await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
      const person = await tx.person.create({ data: { organizationId: org, displayName: "Actual company currency reader" } }), account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } }),
        permission = await tx.permission.findFirstOrThrow({ where: { organizationId: org, key: "company_ledger:view" } }),
        role = await tx.role.create({ data: { organizationId: org, key: "actual_currency_reader", name: "Actual company currency reader", rolePermissions: { create: { organizationId: org, permissionId: permission.id } } } });
      await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, personId: person.id, userAccountId: account.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
      const finance = new FinanceRepository(tx, org), bank = await finance.ensureLedgerAccount({ code: "ORIGINAL_CURRENCY_BANK", name: "Original currency locations", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
        revenue = await finance.ensureLedgerAccount({ code: "ORIGINAL_CURRENCY_REVENUE", name: "Original company income", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
      for (const [currency, value] of [["EUR", "9007199254740993.07"], ["MAD", "10.03"]]) {
        const amount = Money.of(value, currency); await finance.createFinancialTransaction({ reference: "ACTUAL-CURRENCY:" + currency, description: "Original native company currency", occurredAt: new Date("2032-05-02T12:00:00Z"), createdBy: account.id,
          idempotencyKey: randomUUID(), postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }, { ledgerAccountId: revenue.id, side: "CREDIT", amount, bucket: "COMPANY_REVENUE", dimensions: {} }] });
      }
      return { account, person };
    });
    const ctx = { organizationId: org, actorId: identity.account.id, personId: identity.person.id, authContext: await authContextForAccount(org, identity.account.id, { db }) }, before = await originalFacts(org);
    for (const [currency, amount] of [["EUR", "9007199254740993.07"], ["MAD", "10.03"]]) {
      const ledger = await getCompanyLedger(ctx, { currency, timezone: "UTC", fromOn: "2032-05-01", toOn: "2032-05-31" }, { db });
      expect(ledger.currency).toBe(currency); expect(ledger.closingBalance).toBe(amount);
      expect(ledger.accounts.every(row => row.currency === currency)).toBe(true); expect(ledger.lines.every(row => row.currency === currency)).toBe(true);
    }
    const auditCount = () => withTenant(db, org, tx => tx.auditLog.count({ where: { action: "finance.company_ledger.viewed" } })), priorReads = await auditCount(),
      original = Object.getOwnPropertyDescriptor(CompanyLedgerRepository.prototype, "page")!.value as CompanyLedgerRepository["page"],
      spy = vi.spyOn(CompanyLedgerRepository.prototype, "page").mockImplementation(async function (this: CompanyLedgerRepository, input) {
        const page = await original.call(this, input); return { ...page, lines: page.lines.map(line => ({ ...line, currency: "MAD" })) };
      });
    try { await expect(getCompanyLedger(ctx, { currency: "EUR", timezone: "UTC", fromOn: "2032-05-01", toOn: "2032-05-31" }, { db })).rejects.toBeInstanceOf(CompanyLedgerConfigurationError); }
    finally { spy.mockRestore(); }
    expect(await auditCount()).toBe(priorReads);
    expect(await originalFacts(org)).toEqual(before);
  });
});
