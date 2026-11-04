import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { reviewBankReconciliation, matchBankStatement, releaseBankReconciliation, recoverBankReconciliation, readBankReconciliationWorkspace } from "@/modules/finance/application/bank-reconciliation-service";
import { requestBankReconciliationCommand, recoverBankReconciliationCommand } from "@/modules/finance/application/bank-reconciliation-command";
import { reviewGuestDepositReversal, reverseGuestDepositMovement } from "@/modules/finance/application/guest-deposit-service";
import { BankReconciliationRepository } from "@/modules/finance/infrastructure/bank-reconciliation-repository";
import { BankReconciliationAccessError, BankReconciliationConflictError } from "@/modules/finance/domain/bank-reconciliation";
import { bankReconciliationHistorySchema, bankReconciliationSourcesSchema } from "@/modules/finance/domain/bank-reconciliation-workspace";
import { ReconciliationBudgetError } from "@/modules/finance/domain/reconciliation";
import * as auditWriter from "@/platform/audit/audit-writer";
import * as sourceState from "@/modules/finance/domain/bank-statement-source-state";
import { actualBankReconciliationFixture, actualBankReplacementSource } from "./support/bank-reconciliation-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated actual bank removal acceptance database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = "alvillas_ops_tests"; restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
type Fixture = Pick<Awaited<ReturnType<typeof actualBankReconciliationFixture>>, "org" | "ctx">;
const reason = "Review original bank removal and actual retained opposites";
const removalSource = (id = "bank-removal", parent = "bank-1") => actualBankReplacementSource(id, parent, "0.07").replace("<CORRECTACTION>REPLACE", "<CORRECTACTION>DELETE").replace("<TRNAMT>0.07</TRNAMT>", "").replace("<DTPOSTED>20261103</DTPOSTED>", "").replace("<TRNTYPE>CREDIT</TRNTYPE>", "");
const moneyHistory = (f: Fixture) => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'source',id::text,xmin::text,to_jsonb(l) FROM bank_statement_line l WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);
const reviewCommand = async (f: Fixture, input: unknown) => {
  const review = await reviewBankReconciliation(f.ctx, input, { db });
  return { ...input as Record<string, unknown>, idempotencyKey: randomUUID(), reviewFingerprint: review.reviewFingerprint };
};
async function removedFixture(opposite = true) {
  const f = await actualBankReconciliationFixture(db, admin); let oppositePosting: string | null = null;
  if (opposite) {
    const reviewed = await reviewGuestDepositReversal(f.ctx, { transactionId: f.receipt.id }, { db }), reversed = await reverseGuestDepositMovement(f.ctx, { transactionId: f.receipt.id, reviewFingerprint: reviewed.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Append the actual original guest receipt opposite before bank removal review" }, { db });
    oppositePosting = (await withTenant(db, f.org, tx => tx.posting.findFirstOrThrow({ where: { transactionId: reversed.id, ledgerAccountId: f.banks.receipt.id } }))).id;
  }
  await f.admit(removalSource(), "OFX");
  const removal = await withTenant(db, f.org, tx => tx.bankStatementLine.findFirstOrThrow({ where: { externalId: "bank-removal" } }));
  const input = { action: "MATCH" as const, accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.07" }, ...oppositePosting ? [{ id: oppositePosting, amount: "0.07" }] : []], actual: [], reason, varianceAction: opposite ? null : "Investigate the original unmatched financial receipt", evidence: [removal.id] };
  return { ...f, removal, input };
}
describe("native nonmonetary bank removal reconciliation", () => {
  it("retains an actual deletion against original opposite journals without inventing a movement and recovers its exact public receipt", async () => {
    const f = await removedFixture(), before = await moneyHistory(f), input = await reviewCommand(f, f.input), receipt = await requestBankReconciliationCommand(f.ctx, input, { db });
    expect(receipt.result).toMatchObject({ state: "MATCHED", plan: { expected: "0.00", actual: "0.00", variance: "0.00", allocations: { actual: [] }, evidence: [{ side: "ACTUAL", sourceKey: f.removal.id, fingerprint: f.removal.factHash }] } });
    expect(await recoverBankReconciliationCommand(f.ctx, { idempotencyKey: receipt.idempotencyKey }, { db })).toEqual({ request: receipt });
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationAllocation.count({ where: { lineId: f.removal.id } }))).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.count())).toBe(1); expect(await moneyHistory(f)).toEqual(before);
    const released = await releaseBankReconciliation(f.ctx, { action: "RELEASE", id: receipt.result.id, idempotencyKey: randomUUID(), reason: "Release the retained original bank removal association" }, { db });
    expect(released).toMatchObject({ action: "RELEASE", plan: receipt.result.plan }); expect(await recoverBankReconciliation(f.ctx, { idempotencyKey: receipt.idempotencyKey }, { db })).toMatchObject({ state: "RELEASED", plan: receipt.result.plan });
    expect(await matchBankStatement(f.ctx, await reviewCommand(f, f.input), { db })).toMatchObject({ state: "MATCHED" }); expect(await moneyHistory(f)).toEqual(before);
  });
  it("retains an explicit open variance when the original financial source has no opposite", async () => {
    const f = await removedFixture(false), before = await moneyHistory(f), result = await matchBankStatement(f.ctx, await reviewCommand(f, f.input), { db });
    expect(result).toMatchObject({ state: "OPEN_VARIANCE", plan: { expected: "0.07", actual: "0.00", variance: "-0.07", varianceAction: f.input.varianceAction } }); expect(await moneyHistory(f)).toEqual(before);
  });
  it("requires release of every active partial association before admitting its original family's removal", async () => {
    const f = await actualBankReconciliationFixture(db, admin), prior = { action: "MATCH", accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.03" }], actual: [{ id: f.lines[0].id, amount: "0.03" }], reason, varianceAction: null };
    const original = await matchBankStatement(f.ctx, await reviewCommand(f, prior), { db }); await f.admit(removalSource(), "OFX");
    const removal = await withTenant(db, f.org, tx => tx.bankStatementLine.findFirstOrThrow({ where: { externalId: "bank-removal" } }));
    const input = { ...prior, expected: [{ id: f.posting.id, amount: "0.01" }], actual: [], evidence: [removal.id], varianceAction: "Investigate the actual original remaining receipt" };
    await expect(reviewBankReconciliation(f.ctx, input, { db })).rejects.toBeInstanceOf(ReconciliationBudgetError);
    await releaseBankReconciliation(f.ctx, { action: "RELEASE", id: original.id, idempotencyKey: randomUUID(), reason: "Release every active original partial bank association" }, { db });
    expect(await matchBankStatement(f.ctx, await reviewCommand(f, input), { db })).toMatchObject({ state: "OPEN_VARIANCE" });
  });
  it("serializes competing removals into one active original evidence association", async () => {
    const f = await removedFixture(), input = await reviewCommand(f, f.input), results = await Promise.allSettled([matchBankStatement(f.ctx, input, { db }), matchBankStatement(f.ctx, { ...input, idempotencyKey: randomUUID() }, { db })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1); expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.count())).toBe(1);
  });
  it("independently rejects a forged ordinary fact used as removal evidence at PostgreSQL commit", async () => {
    const f = await removedFixture(), command = await reviewCommand(f, f.input), spy = vi.spyOn(BankReconciliationRepository.prototype, "retainEvidence");
    spy.mockImplementation(function (this: BankReconciliationRepository, id, rows) { spy.mockRestore(); return this.retainEvidence(id, rows.map(row => ({ ...row, lineId: f.lines[0].id }))); });
    try { await expect(matchBankStatement(f.ctx, command, { db })).rejects.toThrow("exact current unambiguous bank removal"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(0); expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.count())).toBe(0);
  });
  it("denies competing removal families even when application state projection is forged", async () => {
    const f = await removedFixture(); await f.admit(actualBankReplacementSource("competing", "bank-1", "0.07"), "OFX");
    await expect(reviewBankReconciliation(f.ctx, f.input, { db })).rejects.toBeInstanceOf(BankReconciliationConflictError);
    const original = sourceState.bankStatementSourceStates, spy = vi.spyOn(sourceState, "bankStatementSourceStates").mockImplementation(facts => { const states = new Map(original(facts)); states.set(f.removal.id, "REMOVED"); return states; });
    try { const forged = await reviewCommand(f, f.input); await expect(matchBankStatement(f.ctx, forged, { db })).rejects.toThrow("exact current unambiguous bank removal"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEntry.count())).toBe(0);
  });
  it("denies an unresolved removal whose original bank fact was never retained", async () => {
    const f = await actualBankReconciliationFixture(db, admin); await f.admit(removalSource("orphan-removal", "missing-original"), "OFX");
    const removal = await withTenant(db, f.org, tx => tx.bankStatementLine.findFirstOrThrow({ where: { externalId: "orphan-removal" } }));
    const input = { action: "MATCH", accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.07" }], actual: [], evidence: [removal.id], reason, varianceAction: "Investigate the missing original bank source" };
    await expect(reviewBankReconciliation(f.ctx, input, { db })).rejects.toBeInstanceOf(BankReconciliationConflictError);
    const original = sourceState.bankStatementSourceStates, spy = vi.spyOn(sourceState, "bankStatementSourceStates").mockImplementation(facts => { const states = new Map(original(facts)); states.set(removal.id, "REMOVED"); return states; });
    try { await expect(matchBankStatement(f.ctx, await reviewCommand(f, input), { db })).rejects.toThrow("exact current unambiguous bank removal"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.count())).toBe(0);
  });
  it("retains source-changed history after a late competing correction without rewriting the original evidence", async () => {
    const f = await removedFixture(), command = await reviewCommand(f, f.input), result = await matchBankStatement(f.ctx, command, { db }), saved = await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.findMany());
    await f.admit(actualBankReplacementSource("late-competing", "bank-1", "0.07"), "OFX");
    expect(await recoverBankReconciliation(f.ctx, { idempotencyKey: command.idempotencyKey }, { db })).toMatchObject({ state: "SOURCE_CHANGED", plan: result.plan });
    const history = bankReconciliationHistorySchema.parse(await readBankReconciliationWorkspace(f.ctx, { operation: "HISTORY", accountId: f.banks.receipt.id }, { db })); expect(history.items[0]).toMatchObject({ state: "SOURCE_CHANGED" });
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.findMany())).toEqual(saved);
  });
  it("enforces tenant isolation, append-only evidence and atomic audit on the new native association", async () => {
    const f = await removedFixture(), input = await reviewCommand(f, f.input), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { if (event.action === "finance.bank_reconciliation.matched") throw Error("Retain removal audit atomically"); return original(tx, event); });
    try { await expect(matchBankStatement(f.ctx, input, { db })).rejects.toThrow("Retain removal audit atomically"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.count())).toBe(0);
    const result = await matchBankStatement(f.ctx, input, { db }), row = await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.findFirstOrThrow());
    expect(await withTenant(db, randomUUID(), tx => tx.bankReconciliationEvidence.findMany())).toEqual([]);
    const where = { organizationId_entryId_lineId: { organizationId: f.org, entryId: String(result.id), lineId: f.removal.id } };
    await expect(withTenant(db, f.org, tx => tx.bankReconciliationEvidence.update({ where, data: { sourceSnapshot: {} } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.bankReconciliationEvidence.delete({ where }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.findFirstOrThrow())).toEqual(row);
    const sources = bankReconciliationSourcesSchema.parse(await readBankReconciliationWorkspace(f.ctx, { operation: "SOURCES", accountId: f.banks.receipt.id, currency: "MAD" }, { db })); expect(sources.items.find(source => source.id === f.removal.id)).toMatchObject({ state: "REMOVED", eligible: false });
  });
  it("checks independent current read and reconcile authority for every retained original posting", async () => {
    const f = await removedFixture(); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.matcher.grant.id }, data: { validTo: new Date() } }));
    f.ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
    await expect(matchBankStatement(f.ctx, { ...f.input, idempotencyKey: randomUUID(), reviewFingerprint: "a".repeat(64) }, { db })).rejects.toBeInstanceOf(BankReconciliationAccessError);
    expect(await withTenant(db, f.org, tx => tx.bankReconciliationEvidence.count())).toBe(0);
  });
});
