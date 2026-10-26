import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Dedicated posted journal integrity", baseCurrency: "MAD" } });
  return withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated journal author" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const finance = new FinanceRepository(tx, org);
    const bank = await finance.ensureLedgerAccount({ code: "JOURNAL_INTEGRITY_BANK", name: "Dedicated journal bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    const claim = await finance.ensureLedgerAccount({ code: "JOURNAL_INTEGRITY_CLAIM", name: "Dedicated journal claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    const source = { org, account, bank, claim };
    const journal = await createJournal(tx, source);
    const beforeCommit = await tx.financialTransaction.findUniqueOrThrow({ where: { id: journal.id }, select: { sealed: true } });
    return { ...source, journal, beforeCommit };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function createJournal(tx: TenantTransaction, f: { org: string; account: { id: string }; bank: { id: string }; claim: { id: string } }) {
  const journal = await new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: `Dedicated immutable journal ${randomUUID()}`, description: "Dedicated fictional journal integrity", occurredAt: new Date(), idempotencyKey: randomUUID(), createdBy: f.account.id,
    postings: [{ ledgerAccountId: f.bank.id, side: "DEBIT", amount: Money.of("1", "MAD"), bucket: "JOURNAL_INTEGRITY", dimensions: {} },
      { ledgerAccountId: f.claim.id, side: "CREDIT", amount: Money.of("1", "MAD"), bucket: "JOURNAL_INTEGRITY", dimensions: {} }] });
  await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "local.journal.integrity.created", resourceType: "financial_transaction", resourceId: journal.id,
    after: { amount: "1.00", currency: "MAD" }, reason: "Dedicated fictional journal integrity test", requestId: randomUUID(), occurredAt: new Date() });
  return journal;
}
function moreLines(f: Fixture, transactionId = f.journal.id) {
  return [{ organizationId: f.org, transactionId, ledgerAccountId: f.bank.id, side: "DEBIT", amount: "1", currency: "MAD", bucket: "JOURNAL_INTEGRITY", dimensions: {} },
    { organizationId: f.org, transactionId, ledgerAccountId: f.claim.id, side: "CREDIT", amount: "1", currency: "MAD", bucket: "JOURNAL_INTEGRITY", dimensions: {} }];
}

describe("posted journal boundaries on real PostgreSQL", () => {
  beforeAll(async () => {
    const database = url ? new URL(url) : null;
    const isolatedCi = process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true" && database?.pathname === "/alvillas_os";
    if (!database || !["localhost", "127.0.0.1"].includes(database.hostname) || !(database.pathname.startsWith("/alvillas_automation_") || isolatedCi)) throw Error("Dedicated local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(database); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it("writes a balanced header and all lines atomically, then seals the committed journal", async () => {
    const f = await fixture(); expect(f.beforeCommit.sealed).toBe(false);
    await withTenant(db, f.org, async tx => {
      expect((await tx.financialTransaction.findUniqueOrThrow({ where: { id: f.journal.id } })).sealed).toBe(true);
      const lines = await tx.posting.findMany({ where: { transactionId: f.journal.id } }); expect(lines).toHaveLength(2);
      for (const line of lines) expect(line.amount.toFixed(2)).toBe("1.00");
      expect(await tx.auditLog.count({ where: { resourceId: f.journal.id, action: "local.journal.integrity.created" } })).toBe(1);
    });
  });

  it("rejects balanced lines appended by concurrent committed operations", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 2 }, () => expect(withTenant(db, f.org, tx => tx.posting.createMany({ data: moreLines(f) }))).rejects.toThrow("before their transaction is sealed")));
    expect(await withTenant(db, f.org, tx => tx.posting.count({ where: { transactionId: f.journal.id } }))).toBe(2);
  });

  it("does not permit clients to unseal, update or delete posted financial history", async () => {
    const f = await fixture(), line = await withTenant(db, f.org, tx => tx.posting.findFirstOrThrow({ where: { transactionId: f.journal.id } }));
    for (const mutation of [
      (tx: TenantTransaction) => tx.financialTransaction.update({ where: { id: f.journal.id }, data: { sealed: false } }),
      (tx: TenantTransaction) => tx.financialTransaction.update({ where: { id: f.journal.id }, data: { description: "Forbidden change" } }),
      (tx: TenantTransaction) => tx.financialTransaction.delete({ where: { id: f.journal.id } }),
      (tx: TenantTransaction) => tx.posting.update({ where: { id: line.id }, data: { amount: "2" } }),
      (tx: TenantTransaction) => tx.posting.delete({ where: { id: line.id } })
    ]) await expect(withTenant(db, f.org, async tx => { await mutation(tx); })).rejects.toThrow("append-only");
    expect(await withTenant(db, f.org, tx => tx.posting.count({ where: { transactionId: f.journal.id } }))).toBe(2);
  });

  it("honors explicit constraint finalization and rejects further lines in that transaction", async () => {
    const f = await fixture();
    await expect(withTenant(db, f.org, async tx => {
      const journal = await createJournal(tx, f);
      await tx.$executeRaw(Prisma.sql`SET CONSTRAINTS financial_transaction_finish_write IMMEDIATE`);
      expect((await tx.financialTransaction.findUniqueOrThrow({ where: { id: journal.id } })).sealed).toBe(true);
      await tx.posting.createMany({ data: moreLines(f, journal.id) });
    })).rejects.toThrow("before their transaction is sealed");
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(1);
  });

  it("cannot commit an unsealed header by changing tenant context before finalization", async () => {
    const f = await fixture(), other = await fixture();
    await expect(withTenant(db, f.org, async tx => {
      await createJournal(tx, f);
      await tx.$executeRaw(Prisma.sql`SELECT set_config('app.current_organization_id',${other.org},true)`);
    })).rejects.toThrow(/must have at least two postings|could not be sealed in its tenant scope/u);
    for (const source of [f, other]) expect(await withTenant(db, source.org, tx => tx.financialTransaction.count())).toBe(1);
  });
});
