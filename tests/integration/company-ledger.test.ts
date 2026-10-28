import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { getCompanyLedger, CompanyLedgerAccessError, CompanyLedgerConfigurationError } from "@/modules/finance/application/company-ledger-service";
import { CompanyLedgerRepository } from "@/modules/finance/infrastructure/company-ledger-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";

const url = process.env.TEST_DATABASE_URL;
const client = (datasourceUrl: string) => new PrismaClient({ datasourceUrl, log: [{ emit: "event", level: "query" }] });
let admin: PrismaClient, db: ReturnType<typeof client>;
let postingQueries = 0;
const period = { fromOn: "2026-03-08", toOn: "2026-03-08", timezone: "America/Denver", currency: "MAD" };

async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Dedicated ALVILLAS ledger acceptance", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    for (const code of ["MAD", "EUR"]) await tx.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Private employee name" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const finance = new FinanceRepository(tx, org);
    const company = await finance.ensureLedgerAccount({ code: "ALVILLAS_COMMISSION_REVENUE", name: "Company commissions", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" });
    const expense = await finance.ensureLedgerAccount({ code: "ALVILLAS_EXPENSE", name: "Company expenses", accountType: "ALVILLAS_OWN", normalSide: "DEBIT" });
    const bank = await finance.ensureLedgerAccount({ code: "PRIVATE_COMPANY_BANK", name: "Private funding location", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    const owner = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Private owner liability", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    await new ConfigRuleRepository(tx, org).createVersion({ key: "finance.accounting_periods", scopeType: "organization", scopeId: null,
      effectiveFrom: new Date("2000-01-01"), reason: "Dedicated company calendar", value: { timezone: "America/Denver", allow_early_close: false, max_reopen_seconds: 60 } });
    return { org, account, person, company, expense, bank, owner };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function reader(f: Fixture, options: { scopeType?: string; scopeId?: string; permission?: string; conditions?: Prisma.InputJsonObject } = {}) {
  const grant = await withTenant(db, f.org, async tx => {
    const role = await tx.role.create({ data: { organizationId: f.org, key: `company_reader_${randomUUID()}`, name: "Company reader" } });
    const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: options.permission ?? "company_ledger:view" } });
    await tx.rolePermission.create({ data: { organizationId: f.org, roleId: role.id, permissionId: permission.id } });
    return tx.roleAssignment.create({ data: { organizationId: f.org, personId: f.person.id, userAccountId: f.account.id, roleId: role.id,
      scopeType: options.scopeType ?? "organization", scopeId: options.scopeId ?? null, conditions: options.conditions,
      validFrom: new Date("2000-01-01") } });
  });
  return { grant, ctx: { organizationId: f.org, actorId: f.account.id, authContext: await authContextForAccount(f.org, f.account.id, { db }) } };
}
async function journal(f: Fixture, at: string, amount: string, options: { accountId?: string; side?: "DEBIT" | "CREDIT"; currency?: string; db?: TenantTransactionRunner } = {}) {
  const id = randomUUID(), side = options.side ?? "CREDIT";
  return withTenant(options.db ?? db, f.org, async tx => {
    await tx.$executeRaw(Prisma.sql`INSERT INTO financial_transaction(id,organization_id,reference,description,occurred_at,idempotency_key,created_by)
      VALUES(${id}::uuid,${f.org}::uuid,${"COMPANY-QA:" + id},'Private employee compensation description',${at}::timestamptz,${randomUUID()},${f.account.id}::uuid)`);
    for (const [accountId, postingSide] of [[options.accountId ?? f.company.id, side], [f.bank.id, side === "CREDIT" ? "DEBIT" : "CREDIT"]]) {
      await tx.$executeRaw(Prisma.sql`INSERT INTO posting(organization_id,transaction_id,ledger_account_id,side,amount,currency,bucket,dimensions)
        VALUES(${f.org}::uuid,${id}::uuid,${accountId}::uuid,${postingSide},${amount}::numeric,${options.currency ?? "MAD"},'COMPANY_QA',jsonb_build_object('person_id',${f.person.id}))`);
    }
    return id;
  });
}

describe("separate ALVILLAS ledger on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    db = client(scoped.toString());
    db.$on("query", event => { if (/\b(?:FROM|JOIN) posting\b/u.test(event.query)) postingQueries++; });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it("ties company revenue, expenses and opening at microsecond DST boundaries without owner/cash balances", async () => {
    const f = await fixture(), { ctx } = await reader(f);
    await journal(f, "2026-03-08T06:59:59.999999Z", "8000");
    await journal(f, "2026-03-08T07:00:00Z", "1600");
    await journal(f, "2026-03-09T05:59:59.999999Z", "500", { accountId: f.expense.id, side: "DEBIT" });
    await journal(f, "2026-03-09T06:00:00Z", "999");
    await journal(f, "2026-03-08T12:00:00Z", "100000", { accountId: f.owner.id });
    await journal(f, "2026-03-08T12:00:00Z", "700", { currency: "EUR" });
    const result = await getCompanyLedger(ctx, period, { db, requestId: "company-ledger-view-acceptance" });
    expect(result).toMatchObject({ openingBalance: "8000.00", periodCredits: "1600.00", periodDebits: "500.00", periodResult: "1100.00", closingBalance: "9100.00", rowCount: "2" });
    expect(result.lines.at(-1)?.runningBalance).toBe("9100.00");
    expect(result.accounts.find(row => row.id === f.expense.id)?.closingBalance).toBe("-500.00");
    for (const secret of [f.owner.id, f.owner.name, f.bank.id, f.bank.name, f.person.id, "Private employee"]) expect(JSON.stringify(result)).not.toContain(secret);
    const audit = await withTenant(db, f.org, tx => tx.auditLog.findFirstOrThrow({ where: { action: "finance.company_ledger.viewed" } }));
    expect(audit).toMatchObject({ actorId: f.account.id, requestId: "company-ledger-view-acceptance", resourceType: "company_ledger" });
    expect(JSON.stringify(audit.after)).not.toContain("9100");
  });
  it("has exact zero and currency-separated states", async () => {
    const f = await fixture(), { ctx } = await reader(f);
    expect(await getCompanyLedger(ctx, period, { db })).toMatchObject({ closingBalance: "0.00", rowCount: "0", lines: [], accounts: [] });
    await journal(f, "2026-03-08T12:00:00Z", "12.34", { currency: "EUR" });
    expect((await getCompanyLedger(ctx, period, { db })).closingBalance).toBe("0.00");
    expect((await getCompanyLedger(ctx, { ...period, currency: "EUR" }, { db })).closingBalance).toBe("12.34");
    await expect(getCompanyLedger(ctx, { ...period, currency: "ZZZ" }, { db })).rejects.toBeInstanceOf(CompanyLedgerConfigurationError);
  });
  it.each(["owner_statement:view", "financial_transaction:view", "property:view", "staff_compensation:view"])("does not substitute %s for company access", async permission => {
    const f = await fixture(), { ctx } = await reader(f, { permission });
    await expect(getCompanyLedger(ctx, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "finance.company_ledger.viewed" } }))).toBe(0);
  });
  it.each(["owner", "property", "financial_record"])("denies %s-limited aggregate authority", async scopeType => {
    const f = await fixture(), { ctx } = await reader(f, { scopeType, scopeId: f.org });
    await expect(getCompanyLedger(ctx, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
  });
  it.each(["owner", "property", "financial_record"])("does not turn a wildcard %s grant into the organization company ledger", async scopeType => {
    const f = await fixture(), { ctx } = await reader(f, { scopeType });
    await expect(getCompanyLedger(ctx, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
  });
  it("requires caller and current stored unconditional authority, including revocation", async () => {
    const f = await fixture(), { ctx, grant } = await reader(f);
    await expect(getCompanyLedger({ ...ctx, authContext: { ...ctx.authContext, permissions: new Set() } }, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
    await expect(getCompanyLedger({ ...ctx, authContext: { ...ctx.authContext, assignments: [], scopes: [], permissions: new Set() } }, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: grant.id }, data: { conditions: { maxAmount: "100" } } }));
    await expect(getCompanyLedger(ctx, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: grant.id }, data: { conditions: Prisma.DbNull, validTo: new Date("2020-01-01") } }));
    await expect(getCompanyLedger(ctx, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
  });
  it("denies tenant and caller identity substitution and isolates foreign postings under RLS", async () => {
    const f = await fixture(), foreign = await fixture(), { ctx } = await reader(f);
    await journal(foreign, "2026-03-08T12:00:00Z", "12345");
    expect((await getCompanyLedger(ctx, period, { db })).rowCount).toBe("0");
    await expect(getCompanyLedger({ ...ctx, organizationId: foreign.org }, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
    await expect(getCompanyLedger({ ...ctx, actorId: foreign.account.id }, period, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
    const direct = await withTenant(db, f.org, tx => new CompanyLedgerRepository(tx, foreign.org).totals({ startsAt: new Date("2026-03-08"), endsAt: new Date("2026-03-10"), currency: "MAD" }));
    expect(direct).toEqual([]);
  });
  it("pages timestamp ties without duplicates and computes running balances before paging", async () => {
    const f = await fixture(), { ctx } = await reader(f);
    for (let index = 0; index < 53; index++) await journal(f, index < 51 ? "2026-03-08T07:00:00.000001Z" : "2026-03-08T07:00:00.000002Z", "0.01");
    const first = await getCompanyLedger(ctx, period, { db });
    expect(first.lines).toHaveLength(50); expect(first.lines[49].runningBalance).toBe("0.50");
    const next = await getCompanyLedger(ctx, { ...period, after: first.next }, { db });
    expect(next.lines).toHaveLength(3); expect(next.next).toBeUndefined(); expect(next.lines.at(-1)?.runningBalance).toBe("0.53");
    expect(new Set([...first.lines, ...next.lines].map(row => row.id)).size).toBe(53);
    expect((await getCompanyLedger(ctx, { ...period, after: next.lines[2].id }, { db })).lines).toEqual([]);
    await expect(getCompanyLedger(ctx, { ...period, after: randomUUID() }, { db })).rejects.toBeInstanceOf(CompanyLedgerAccessError);
  });
  it("keeps 500 large movements exact in two posting queries and preserves archived history", async () => {
    const f = await fixture(), { ctx } = await reader(f);
    for (let index = 0; index < 500; index++) await journal(f, "2026-03-08T06:59:59Z", "9999999999999999.99");
    await journal(f, "2026-03-08T07:00:00Z", "0.01");
    await withTenant(db, f.org, tx => tx.ledgerAccount.update({ where: { id: f.company.id }, data: { archivedAt: new Date() } }));
    postingQueries = 0;
    const result = await getCompanyLedger(ctx, period, { db });
    expect(postingQueries).toBe(2);
    expect(result).toMatchObject({ openingBalance: "4999999999999999995.00", closingBalance: "4999999999999999995.01" });
    expect(result.lines[0].runningBalance).toBe("4999999999999999995.01");
  });
  it("pins totals and page to one snapshot while another connection commits", async () => {
    const f = await fixture(), { ctx } = await reader(f);
    await journal(f, "2026-03-08T12:00:00Z", "10");
    const original = Object.getOwnPropertyDescriptor(CompanyLedgerRepository.prototype, "totals")?.value as CompanyLedgerRepository["totals"];
    const spy = vi.spyOn(CompanyLedgerRepository.prototype, "totals").mockImplementationOnce(async function (this: CompanyLedgerRepository, ...args) {
      const result = await original.apply(this, args);
      await journal(f, "2026-03-08T13:00:00Z", "15", { db: admin });
      return result;
    });
    try { expect(await getCompanyLedger(ctx, period, { db })).toMatchObject({ closingBalance: "10.00", rowCount: "1", lines: [expect.objectContaining({ runningBalance: "10.00" })] }); }
    finally { spy.mockRestore(); }
    expect((await getCompanyLedger(ctx, period, { db })).closingBalance).toBe("25.00");
  });
  it("records reversals as movements without mutating original company journal facts", async () => {
    const f = await fixture(), { ctx } = await reader(f), financeId = await journal(f, "2026-03-08T12:00:00Z", "25");
    const before = await withTenant(db, f.org, tx => tx.financialTransaction.findUniqueOrThrow({ where: { id: financeId }, include: { postings: true } }));
    await withTenant(db, f.org, async tx => {
      const reversal = await new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: `COMPANY-REV:${randomUUID()}`, description: "Dedicated company reversal", occurredAt: new Date("2026-03-08T13:00:00Z"), idempotencyKey: randomUUID(),
        createdBy: f.account.id, reversesTransactionId: financeId, postings: before.postings.map(posting => ({ ledgerAccountId: posting.ledgerAccountId, side: posting.side === "DEBIT" ? "CREDIT" : "DEBIT", amount: Money.of(posting.amount.toString(), posting.currency), bucket: posting.bucket, dimensions: posting.dimensions as Record<string, unknown> })) });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "finance.company_ledger.fixture.reversed", resourceType: "financial_transaction", resourceId: financeId,
        after: { transactionId: financeId, reversalTransactionId: reversal.id }, reason: "Dedicated company journal fixture reversal", requestId: randomUUID(), occurredAt: new Date() });
    });
    expect((await getCompanyLedger(ctx, period, { db })).closingBalance).toBe("0.00");
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.findUniqueOrThrow({ where: { id: financeId }, include: { postings: true } }))).toEqual(before);
  });
});
