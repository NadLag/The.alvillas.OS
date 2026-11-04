import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { reviewBankReconciliation, matchBankStatement, recoverBankReconciliation, releaseBankReconciliation, readBankReconciliationWorkspace } from "@/modules/finance/application/bank-reconciliation-service";
import { requestBankReconciliationCommand, recoverBankReconciliationCommand, bankReconciliationCommandStatus } from "@/modules/finance/application/bank-reconciliation-command";
import { bankReconciliationSourcesSchema, bankReconciliationHistorySchema, bankReconciliationPostingsSchema } from "@/modules/finance/domain/bank-reconciliation-workspace";
import { BankReconciliationAccessError, BankReconciliationConflictError } from "@/modules/finance/domain/bank-reconciliation";
import * as auditWriter from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { BankReconciliationRepository } from "@/modules/finance/infrastructure/bank-reconciliation-repository";
import { actualBankReconciliationFixture, actualBankReplacementSource } from "./support/bank-reconciliation-fixture";
import * as bankSourceState from "@/modules/finance/domain/bank-statement-source-state";
import { ReconciliationBudgetError } from "@/modules/finance/domain/reconciliation";
import { provisionIntegrationRole } from "./support/database-role";
import { transactionQueryMeasurement } from "./support/transaction-query-measurement";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient, queryMeasurement: ReturnType<typeof transactionQueryMeasurement>;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated native bank reconciliation database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const scoped = new URL(url!); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
  const observed = new PrismaClient({ datasourceUrl: scoped.toString(), log: [{ emit: "event", level: "query" }] }); queryMeasurement = transactionQueryMeasurement(observed); observed.$on("query", event => queryMeasurement.observe(event.query)); db = observed;
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
type Fixture = Awaited<ReturnType<typeof actualBankReconciliationFixture>>;
const intent = (f: Fixture, expected = "0.07", actual = f.lines.map(line => ({ id: line.id, amount: line.amount!.toFixed(2) })), varianceAction: string | null = null) =>
  ({ action: "MATCH" as const, accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: expected }], actual, reason: "Confirm the actual original bank and posted receipt", varianceAction });
const command = async (f: Fixture, input = intent(f)) => ({ ...input, idempotencyKey: randomUUID(), reviewFingerprint: String((await reviewBankReconciliation(f.ctx, input, f.deps)).reviewFingerprint) });
const originalMoney = (f: Fixture) => withTenant(db, f.org, tx => tx.$queryRaw`SELECT 'transaction' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'source',id::text,xmin::text,to_jsonb(l) FROM bank_statement_line l WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);

describe("actual original bank reconciliation", () => {
  it("matches actual retained source and native bank posting without changing any financial or bank fact", async () => {
    const f = await actualBankReconciliationFixture(db, admin), before = await originalMoney(f), result = await matchBankStatement(f.ctx, await command(f), f.deps);
    expect(result).toMatchObject({ action: "MATCH", plan: { expected: "0.07", actual: "0.07", variance: "0.00", classification: "EXACT" } });
    expect(await originalMoney(f)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.count())).toBe(2);
  });
  it("retains grouped and partial allocations and releases their derived budget through append-only history", async () => {
    const f = await actualBankReconciliationFixture(db, admin, ["0.03", "0.04"]), before = await originalMoney(f);
    const first = await matchBankStatement(f.ctx, await command(f, intent(f, "0.03", [{ id: f.lines[0].id, amount: "0.03" }])), f.deps);
    const second = await matchBankStatement(f.ctx, await command(f, intent(f, "0.04", [{ id: f.lines[1].id, amount: "0.04" }])), f.deps);
    expect(second.plan).toMatchObject({ expected: "0.04", allocations: { expected: [{ original: "0.07", allocatedBefore: "0.03", amount: "0.04" }] } });
    await expect(reviewBankReconciliation(f.ctx, intent(f), f.deps)).rejects.toThrow("reconciliation_source_budget_exceeded");
    for (const id of [first.id, second.id]) await releaseBankReconciliation(f.ctx, { action: "RELEASE", id, idempotencyKey: randomUUID(), reason: "Release only the original reconciliation association" }, f.deps);
    expect((await matchBankStatement(f.ctx, await command(f), f.deps)).plan).toMatchObject({ expected: "0.07", actual: "0.07", variance: "0.00" });
    expect(await originalMoney(f)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(5);
  });
  it("recovers the exact actor-bound result after matching authority ends and rejects changed intent", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f), result = await matchBankStatement(f.ctx, input, f.deps);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.matcher.grant.id }, data: { validTo: new Date() } }));
    const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
    expect((await recoverBankReconciliation(ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).id).toBe(result.id);
    expect((await matchBankStatement(ctx, input, f.deps)).id).toBe(result.id);
    await expect(matchBankStatement(ctx, { ...input, reason: "A different matching intention" }, f.deps)).rejects.toBeInstanceOf(BankReconciliationConflictError);
    await expect(releaseBankReconciliation(ctx, { action: "RELEASE", id: result.id, idempotencyKey: randomUUID(), reason: "Cannot release without matching authority" }, f.deps)).rejects.toBeInstanceOf(BankReconciliationAccessError);
  });
  it("serializes competing admissions and does not allocate one actual movement twice", async () => {
    const f = await actualBankReconciliationFixture(db, admin), one = await command(f), two = { ...one, idempotencyKey: randomUUID() };
    const results = await Promise.allSettled([matchBankStatement(f.ctx, one, f.deps), matchBankStatement(f.ctx, two, f.deps)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(1);
  });
  it("requires the matching audit in the same native transaction", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => event.action === "finance.bank_reconciliation.matched" ? undefined : original(tx, event));
    try { await expect(matchBankStatement(f.ctx, input, f.deps)).rejects.toThrow("reconciliation must retain exact"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.count())).toBe(0);
  });
  it("rolls back both allocations and audit after final matching authority is revoked", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (client, event) => {
      const result = await original(client, event);
      if (event.action === "finance.bank_reconciliation.matched") await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.matcher.grant.id }, data: { validTo: new Date() } }));
      return result;
    });
    try { await expect(matchBankStatement(f.ctx, input, f.deps)).rejects.toBeInstanceOf(BankReconciliationAccessError); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "finance.bank_reconciliation.matched" } }))).toBe(0);
  });
  it("retains a real nonzero variance as open even when it is inside the configured tolerance", async () => {
    const f = await actualBankReconciliationFixture(db, admin, ["0.08"]);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: new Date(), createdBy: f.account.id,
      value: { ...f.policy, matching: { ...f.policy.matching, amount_tolerance: "0.01" } }, reason: "Explicit configured original matching tolerance" }));
    const before = await originalMoney(f), action = "Investigate the original one-cent bank discrepancy";
    await expect(reviewBankReconciliation(f.ctx, intent(f), f.deps)).rejects.toThrow("reconciliation_source_unavailable");
    const result = await matchBankStatement(f.ctx, await command(f, intent(f, "0.07", undefined, action)), f.deps);
    expect(result).toMatchObject({ state: "OPEN_VARIANCE", plan: { expected: "0.07", actual: "0.08", variance: "0.01", classification: "WITHIN_TOLERANCE", varianceAction: action } });
    expect(await originalMoney(f)).toEqual(before);
  });
  it("reopens a retained match after a real bank replacement and requires release before using its original posting again", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f), result = await matchBankStatement(f.ctx, input, f.deps);
    await f.admit(actualBankReplacementSource("bank-replacement", "bank-1", "0.07"), "OFX");
    expect(await recoverBankReconciliation(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toMatchObject({ id: result.id, state: "SOURCE_CHANGED" });
    await expect(reviewBankReconciliation(f.ctx, intent(f), f.deps)).rejects.toBeInstanceOf(BankReconciliationConflictError);
    const replacement = await withTenant(db, f.org, tx => tx.bankStatementLine.findFirstOrThrow({ where: { externalId: "bank-replacement" } }));
    const corrected = intent(f, "0.07", [{ id: replacement.id, amount: "0.07" }]);
    await expect(reviewBankReconciliation(f.ctx, corrected, f.deps)).rejects.toThrow("reconciliation_source_budget_exceeded");
    await releaseBankReconciliation(f.ctx, { action: "RELEASE", id: result.id, idempotencyKey: randomUUID(), reason: "Release superseded original bank match for explicit corrected review" }, f.deps);
    expect(await matchBankStatement(f.ctx, await command(f, corrected), f.deps)).toMatchObject({ state: "MATCHED" });
    expect(await recoverBankReconciliation(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toMatchObject({ state: "RELEASED" });
  });
  it("returns one actor-bound result for simultaneous retries of the exact same command", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f);
    const results = await Promise.all([matchBankStatement(f.ctx, input, f.deps), matchBankStatement(f.ctx, input, f.deps)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "finance.bank_reconciliation.matched" } }))).toBe(1);
  });
  it("rejects a forged allocation independently at the native source and plan boundary", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f);
    const spy = vi.spyOn(BankReconciliationRepository.prototype, "allocate");
    spy.mockImplementation(function (this: BankReconciliationRepository, id, rows) {
      spy.mockRestore();
      return this.allocate(id, rows.map(row => ({ ...row, amount: row.postingId ? "0.01" : row.amount })));
    });
    try { await expect(matchBankStatement(f.ctx, input, f.deps)).rejects.toThrow("exact original bank posting"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(0);
  });
  it("enforces forced tenant isolation and immutable match and allocation history", async () => {
    const f = await actualBankReconciliationFixture(db, admin), result = await matchBankStatement(f.ctx, await command(f), f.deps), foreignOrg = randomUUID();
    expect(await withTenant(db, foreignOrg, tx => tx.bankReconciliationEntry.findMany())).toEqual([]);
    expect(await withTenant(db, foreignOrg, tx => tx.bankReconciliationAllocation.findMany())).toEqual([]);
    const allocation = await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.findFirstOrThrow());
    await expect(withTenant(db, f.org, tx => tx.bankReconciliationEntry.update({ where: { id: String(result.id) }, data: { reason: "Rewrite must be rejected by immutable history" } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.bankReconciliationEntry.delete({ where: { id: String(result.id) } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.bankReconciliationAllocation.update({ where: { id: allocation.id }, data: { amount: "0.01" } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.bankReconciliationAllocation.delete({ where: { id: allocation.id } }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.count())).toBe(2);
  });
  it("acknowledges, recovers and reports the original typed command using one retained actor nonce", async () => {
    const f = await actualBankReconciliationFixture(db, admin), input = await command(f);
    expect(await recoverBankReconciliationCommand(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toEqual({ request: null });
    const result = await requestBankReconciliationCommand(f.ctx, input, f.deps);
    expect(result).toMatchObject({ requestId: result.result.id, state: "SUCCEEDED", operation: "MATCH", result: { state: "MATCHED" } });
    expect(await recoverBankReconciliationCommand(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toEqual({ request: result });
    expect(await bankReconciliationCommandStatus(f.ctx, { id: result.requestId }, f.deps)).toEqual(result);
    const released = await requestBankReconciliationCommand(f.ctx, { action: "RELEASE", id: result.result.id, idempotencyKey: randomUUID(), reason: "Release the original association through its durable command" }, f.deps);
    expect(released.result).toMatchObject({ action: "RELEASE", state: "RELEASED", originalId: result.result.id });
    expect(await recoverBankReconciliationCommand(f.ctx, { idempotencyKey: released.idempotencyKey }, f.deps)).toEqual({ request: released });
    await expect(bankReconciliationCommandStatus(f.ctx, { id: randomUUID() }, f.deps)).rejects.toBeInstanceOf(BankReconciliationAccessError);
  });
  it("normalizes UUID wire casing before preserving the exact native command hash", async () => {
    const f = await actualBankReconciliationFixture(db, admin), raw = intent(f);
    const upper = { ...raw, accountId: raw.accountId.toUpperCase(), expected: raw.expected.map(row => ({ ...row, id: row.id.toUpperCase() })), actual: raw.actual.map(row => ({ ...row, id: row.id.toUpperCase() })) };
    const review = await reviewBankReconciliation(f.ctx, upper, f.deps);
    const result = await matchBankStatement(f.ctx, { ...upper, idempotencyKey: randomUUID().toUpperCase(), reviewFingerprint: review.reviewFingerprint }, f.deps);
    expect(result).toMatchObject({ accountId: f.banks.receipt.id, state: "MATCHED" });
  });
  it("pages 502 actual bank sources with a constant query count and derives allocated amounts from retained matches", async () => {
    const f = await actualBankReconciliationFixture(db, admin);
    await f.admit("Date;ID;Reference;Description;Amount;Currency\n" + Array.from({ length: 501 }, (_, i) => `2026-11-03;page-${i};actual-reference;Actual original source page;0.01;MAD`).join("\n"));
    let after: string | undefined, seen = 0; const queries: number[] = [], pageSignatures: string[][] = [];
    do {
      const measured = await queryMeasurement.measure(() => readBankReconciliationWorkspace(f.ctx, { operation: "SOURCES", accountId: f.banks.receipt.id, currency: "MAD", after }, f.deps));
      const page = bankReconciliationSourcesSchema.parse(measured.value);
      queries.push(measured.count); seen += page.items.length; after = page.next ?? undefined;
      pageSignatures.push(measured.queries.map(query => query.trim().replace(/\s+/gu, " ").slice(0, 100)));
      expect(page.items.every(row => row.state === "ACTIVE" && row.eligible && row.allocated.amount === "0.00")).toBe(true);
    } while (after);
    console.log(JSON.stringify({ actualBankSources: seen, pageQueryCounts: queries, protocolStatements: [...new Set(pageSignatures.flat().filter(query => !query.includes('"public"') && !query.startsWith("WITH")))] }));
    const fewest = Math.min(...queries), examples = [pageSignatures[queries.indexOf(fewest)], ...pageSignatures.filter((_, index) => queries[index] !== fewest)];
    expect(seen).toBe(502); expect(queries).toHaveLength(11); expect(new Set(queries).size, JSON.stringify({ counts: queries, examples })).toBe(1);
    const result = await matchBankStatement(f.ctx, await command(f), f.deps);
    const history = bankReconciliationHistorySchema.parse(await readBankReconciliationWorkspace(f.ctx, { operation: "HISTORY", accountId: f.banks.receipt.id }, f.deps));
    expect(history.items).toHaveLength(1); expect(history.items[0]).toMatchObject({ id: result.id, state: "MATCHED", plan: { variance: "0.00" } });
    const ledger = bankReconciliationPostingsSchema.parse(await readBankReconciliationWorkspace(f.ctx, { operation: "POSTINGS", accountId: f.banks.receipt.id, currency: "MAD", lineId: f.lines[0].id }, f.deps));
    expect(ledger.items.find(row => row.id === f.posting.id)).toMatchObject({ allocated: { amount: "0.07" }, remaining: { amount: "0.00" }, suggested: false });
  });
  it("never projects an opposing private liability as a bank account even for an organization-scoped bank reader", async () => {
    const f = await actualBankReconciliationFixture(db, admin);
    const opposing = await withTenant(db, f.org, tx => tx.posting.findFirstOrThrow({ where: { transactionId: f.receipt.id, ledgerAccountId: { not: f.banks.receipt.id } } }));
    await expect(readBankReconciliationWorkspace(f.ctx, { operation: "POSTINGS", accountId: opposing.ledgerAccountId, currency: "MAD" }, f.deps)).rejects.toBeInstanceOf(BankReconciliationAccessError);
    await expect(readBankReconciliationWorkspace(f.ctx, { operation: "POSTINGS", accountId: f.banks.refund.id, currency: "MAD" }, f.deps)).rejects.toBeInstanceOf(BankReconciliationAccessError);
  });
  it("requires release of a partial original association before its replacement at both application and native boundaries", async () => {
    const f = await actualBankReconciliationFixture(db, admin), first = await matchBankStatement(f.ctx, await command(f, intent(f, "0.03", [{ id: f.lines[0].id, amount: "0.03" }])), f.deps);
    await f.admit(actualBankReplacementSource("bank-partial-replacement", "bank-1", "0.08"), "OFX");
    const replacement = await withTenant(db, f.org, tx => tx.bankStatementLine.findFirstOrThrow({ where: { externalId: "bank-partial-replacement" } }));
    const corrected = intent(f, "0.04", [{ id: replacement.id, amount: "0.04" }]), before = await originalMoney(f);
    await expect(reviewBankReconciliation(f.ctx, corrected, f.deps)).rejects.toBeInstanceOf(ReconciliationBudgetError);
    const page = bankReconciliationSourcesSchema.parse(await readBankReconciliationWorkspace(f.ctx, { operation: "SOURCES", accountId: f.banks.receipt.id, currency: "MAD" }, f.deps));
    expect(page.items.find(row => row.id === replacement.id)).toMatchObject({ state: "ACTIVE", eligible: false, remaining: { amount: "0.08" } });
    const spy = vi.spyOn(bankSourceState, "bankStatementSourceFamilyMembers").mockImplementation(facts => new Map(facts.map(fact => [fact.id, [fact.id]])));
    try { await expect(matchBankStatement(f.ctx, await command(f, corrected), f.deps)).rejects.toThrow("bank correction requires release of every active original source association"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(1);
    await releaseBankReconciliation(f.ctx, { action: "RELEASE", id: first.id, idempotencyKey: randomUUID(), reason: "Release the actual old partial association before replacement review" }, f.deps);
    expect(await matchBankStatement(f.ctx, await command(f, corrected), f.deps)).toMatchObject({ state: "MATCHED", plan: { expected: "0.04", actual: "0.04" } });
    expect(await originalMoney(f)).toEqual(before);
  });
});
