import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { importAirbnbSettlementCsv, AirbnbSettlementAuthorizationError } from "@/modules/finance/application/airbnb-settlement-service";
import * as auditWriter from "@/platform/audit/audit-writer";
import { actualOtaSettlementFixture } from "./support/ota-settlement-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated actual OTA reconciliation database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = "alvillas_ops_tests"; restricted.password = "alvillas_ops_tests";
  db = new PrismaClient({ datasourceUrl: restricted.toString() });
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

const fixture = (actual = "0.07") => actualOtaSettlementFixture(db, admin, actual);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const financial = (f: Fixture) => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);
const audits = (f: Fixture) => withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { action: "airbnb.settlement.imported" } }));

describe("native OTA evidence through the shared reconciliation model", () => {
  it.each([["0.07", "0.00", "MATCHED"], ["0.03", "-0.04", "OPEN_VARIANCE"], ["0.08", "0.01", "OPEN_VARIANCE"], ["0.00", "-0.07", "OPEN_VARIANCE"]])("retains genuine original sources and signed variance for actual %s", async (actual, variance, state) => {
    const f = await fixture(actual), prior = await financial(f), result = await importAirbnbSettlementCsv(f.ctx, f.input, f.deps), item = result.imported[0];
    const events = await audits(f); expect(events).toHaveLength(1);
    const payload = events[0].after as Record<string, unknown>, reconciliation = payload.reconciliation as { sourceId: string; plan: { allocations: { expected: Array<{ sourceKey: string }>; actual: Array<{ sourceKey: string }> }; evidence: Array<{ side: string; sourceKey: string; fingerprint: string }> } };
    expect(reconciliation).toMatchObject({ provider: "OTA", sourceType: "AIRBNB_SETTLEMENT", sourceId: item.settlementId, state,
      plan: { unit: "MONEY:MAD", expected: "0.07", actual, variance, reason: "Investigate original OTA source", varianceAction: state === "MATCHED" ? null : "Review original provider evidence" } });
    const sources = await withTenant(db, f.org, tx => tx.posting.findMany({ where: { transactionId: { in: [item.expectedTransactionId, item.receiptTransactionId] } } }));
    for (const source of reconciliation.plan.allocations.expected) expect(sources.find(row => row.id === source.sourceKey)).toMatchObject({ transactionId: item.expectedTransactionId, side: "DEBIT", bucket: "OTA_SETTLEMENT" });
    for (const source of reconciliation.plan.allocations.actual) expect(sources.find(row => row.id === source.sourceKey)).toMatchObject({ transactionId: item.receiptTransactionId, side: "DEBIT", bucket: "OTA_RECEIPT", ledgerAccountId: f.banks.receipt.id });
    if (actual === "0.00") { expect(reconciliation.plan.allocations.actual).toEqual([]); expect(reconciliation.plan.evidence).toMatchObject([{ side: "ACTUAL", sourceKey: item.settlementId }]); expect(reconciliation.plan.evidence[0].fingerprint).toMatch(/^[a-f0-9]{64}$/u); expect(sources.some(row => row.amount.isZero())).toBe(false); }
    else expect(reconciliation.plan.evidence).toEqual([]);
    const variances = await withTenant(db, f.org, tx => tx.variance.findMany());
    expect(variances).toHaveLength(state === "MATCHED" ? 0 : 1);
    if (variances.length) expect(variances[0]).toMatchObject({ sourceId: item.settlementId, status: "OPEN", reason: "Investigate original OTA source", action: "Review original provider evidence" });
    const after = await financial(f); expect(after.filter(row => prior.some(original => original.id === row.id))).toEqual(prior);
    const replay = await importAirbnbSettlementCsv(f.ctx, f.input, f.deps);
    expect(replay.imported[0]).toMatchObject({ settlementId: item.settlementId, expectedTransactionId: item.expectedTransactionId, receiptTransactionId: item.receiptTransactionId, varianceId: item.varianceId, idempotent: true });
    expect(await financial(f)).toEqual(after); expect(await audits(f)).toHaveLength(1);
    const foreign = randomUUID(); expect(await withTenant(db, foreign, tx => tx.airbnbSettlement.findMany({ where: { id: item.settlementId } }))).toEqual([]);
    expect(await withTenant(db, foreign, tx => tx.auditLog.findMany({ where: { resourceId: item.settlementId } }))).toEqual([]);
  });
  it("rolls back the entire new settlement when retaining its shared source evidence fails", async () => {
    const f = await fixture("0.03"), prior = await financial(f), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { if (event.action === "airbnb.settlement.imported") throw Error("Retain original reconciliation audit atomically"); return original(tx, event); });
    try { await expect(importAirbnbSettlementCsv(f.ctx, f.input, f.deps)).rejects.toThrow("Retain original reconciliation audit atomically"); } finally { spy.mockRestore(); }
    expect(await financial(f)).toEqual(prior); expect(await audits(f)).toEqual([]);
    expect(await withTenant(db, f.org, tx => tx.airbnbSettlement.count())).toBe(0); expect(await withTenant(db, f.org, tx => tx.variance.count())).toBe(0);
  });
  it("serializes simultaneous retries against one original source and returns the same complete acknowledgement", async () => {
    const f = await fixture("0.00"), prior = await financial(f), results = await Promise.all([importAirbnbSettlementCsv(f.ctx, f.input, f.deps), importAirbnbSettlementCsv(f.ctx, f.input, f.deps)]);
    const items = results.map(result => result.imported[0]);
    expect(items.map(item => item.idempotent).sort()).toEqual([false, true]);
    expect(items[0]).toMatchObject({ settlementId: items[1].settlementId, expectedTransactionId: items[1].expectedTransactionId, receiptTransactionId: items[1].receiptTransactionId, varianceId: items[1].varianceId });
    expect(items[0].receiptTransactionId).toMatch(/^[a-f0-9-]{36}$/u); expect(items[0].varianceId).not.toBeNull();
    expect(await audits(f)).toHaveLength(1); expect(await withTenant(db, f.org, tx => tx.airbnbSettlement.count())).toBe(1); expect(await withTenant(db, f.org, tx => tx.variance.count())).toBe(1);
    expect((await financial(f)).filter(row => prior.some(original => original.id === row.id))).toEqual(prior);
  });
  it("rechecks an independently ended grant after the final evidence audit and preserves prior financial history", async () => {
    const f = await fixture("0.03"), prior = await financial(f), original = auditWriter.writeAuditEvent; let ended = false;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await original(tx, event);
      if (event.action === "airbnb.settlement.imported") { await withTenant(db, f.org, async current => { const [row] = await current.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`; await current.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: row.now } }); }); ended = true; }
      return result;
    });
    try { await expect(importAirbnbSettlementCsv(f.ctx, f.input, f.deps)).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError); } finally { spy.mockRestore(); }
    expect(ended).toBe(true); expect(await financial(f)).toEqual(prior); expect(await audits(f)).toEqual([]);
    expect(await withTenant(db, f.org, tx => tx.airbnbSettlement.count())).toBe(0); expect(await withTenant(db, f.org, tx => tx.variance.count())).toBe(0);
  });
});
