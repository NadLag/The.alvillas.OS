import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import * as auditWriter from "@/platform/audit/audit-writer";
import { createManualReservation } from "@/modules/reservations/application/reservation-service";
import { importAirbnbSettlementCsv, reverseAirbnbSettlement } from "@/modules/finance/application/airbnb-settlement-service";
import { commandVarianceWorkflow, readVarianceWorkflow, recoverVarianceWorkflow, readVarianceWorkflowHistory } from "@/modules/finance/application/variance-workflow-service";
import { authorizeOtaVarianceSource } from "@/modules/finance/application/variance-source-ota";
import { VarianceWorkflowConflictError, VarianceWorkflowSourceError } from "@/modules/finance/domain/variance-workflow";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";
import { actualBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import { matchBankStatement, reviewBankReconciliation, releaseBankReconciliation } from "@/modules/finance/application/bank-reconciliation-service";
import { authorizeVarianceSource } from "@/platform/reconciliation/variance-source-authority";
import { prepareFieldStocktakeBatch, recordFieldStocktakeInTransaction } from "@/platform/inventory/field-stocktake-service";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { listAuditHistory } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";
import { readVarianceCenter } from "@/modules/finance/application/variance-center-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw new Error("Dedicated native variance database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture() {
  const f = await actualGuestDepositFixture(db, admin), externalId = randomUUID();
  await withTenant(db, f.org, async tx => {
    const keys = ["reservation:view", "financial_transaction:reconcile", "financial_transaction:assign", "audit_log:view"];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    const existing = new Set((await tx.rolePermission.findMany({ where: { organizationId: f.org, roleId: f.role.id } })).map(row => row.permissionId));
    await tx.rolePermission.createMany({ data: permissions.filter(permission => !existing.has(permission.id)).map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })) });
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
  await createManualReservation(ctx, { propertyId: f.property.id, source: "AIRBNB", externalId, guestName: "Actual variance workflow guest", guestEmail: "actual-variance@example.test",
    checkIn: "2031-05-01", checkOut: "2031-05-04", adultCount: 1, childCount: 0, quote: { amount: "0.07", currency: "MAD" }, idempotencyKey: randomUUID() }, { db, requestId: randomUUID() });
  const imported = await importAirbnbSettlementCsv(ctx, { receivedAccountId: f.banks.receipt.id, idempotencyKey: randomUUID(),
    csv: "source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action\n" +
      `${externalId},actual-variance-payout,${randomUUID()},MAD,0.07,0.00,0.07,0.03,Actual original settlement difference,Review original provider evidence` }, { db, requestId: randomUUID(), ipAddress: null });
  const item = imported.imported[0]; if (!item.varianceId) throw new Error("Actual posted nonzero variance required");
  const source = { provider: "OTA" as const, id: item.varianceId }, deps = { db, authorizeSource: authorizeOtaVarianceSource, requestId: randomUUID() };
  const current = await readVarianceWorkflow(ctx, { source }, deps);
  const intent = { source, version: current.version, sourceFingerprint: current.sourceFingerprint, reason: "Assign an actual original settlement difference", operation: "ASSIGN" as const, assignedTo: f.account.id };
  return { ...f, ctx, source, deps, current, intent, item };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const snapshot = (f: Pick<Fixture, "org">) => withTenant(db, f.org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: unknown }>>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid
  UNION ALL SELECT 'variance',id::text,xmin::text,to_jsonb(v) FROM variance v WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);

describe("native attributed variance workflow", () => {
  it("waits for an in-flight original nonce before reporting recovery instead of declaring its uncommitted effect missing", async () => {
    const f = await fixture(), idempotencyKey = randomUUID(), original = auditWriter.writeAuditEvent;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const row = await original(tx, event);
      if (event.resourceType === "variance_workflow_event") { entered(); await gate; }
      return row;
    });
    const writing = commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: idempotencyKey.toUpperCase() }, f.deps);
    let recovery: ReturnType<typeof recoverVarianceWorkflow> | undefined;
    try {
      await Promise.race([ready, writing.then(() => undefined)]);
      recovery = recoverVarianceWorkflow(f.ctx, { source: f.source, idempotencyKey }, f.deps);
      await vi.waitFor(async () => {
        const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
        expect(row.waiting).toBe(true);
      }, { timeout: 2000, interval: 20 });
    } finally { release(); spy.mockRestore(); }
    const saved = await writing;
    expect(await recovery).toMatchObject({ receipt: { eventId: saved.eventId, idempotencyKey, version: "1", idempotent: true } });
    expect(await withTenant(db, f.org, tx => tx.varianceWorkflowEvent.count())).toBe(1);
  });
  it("keeps physical discrepancy resolution operational while retaining the original count and adjustment", async () => {
    const f = await actualGuestDepositFixture(db, admin);
    const originalFinancial = await snapshot(f);
    const native = await withTenant(db, f.org, async tx => {
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["task:view", "task:edit", "task:assign"] } } });
      expect(permissions).toHaveLength(3);
      await tx.rolePermission.createMany({ data: permissions.map(row => ({ organizationId: f.org, roleId: f.role.id, permissionId: row.id })), skipDuplicates: true });
      const task = await tx.operationTask.create({ data: { organizationId: f.org, propertyId: f.property.id, assignedToUserAccountId: f.account.id,
        assignedToPersonId: f.person.id, state: "ASSIGNED", type: "INSPECTION", dueDate: new Date("2031-05-01"),
        titleTranslations: { en: "Observe actual linen", fr: "Compter le linge" }, idempotencyKey: randomUUID(), createdBy: f.account.id } });
      const rule = await new ConfigRuleRepository(tx, f.org).createVersion({ key: "inventory.minimums", scopeType: "property", scopeId: f.property.id,
        value: { minimums: [{ item: "bath_towel", quantity: 8, category: "LINEN", unit: "pieces", name: { en: "Bath towel", fr: "Serviette", ar: "منشفة" } }] },
        effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id, reason: "Actual physical count catalog for authorized variance review" });
      return { task, rule };
    });
    const held = await authContextForAccount(f.org, f.account.id, { db });
    const ctx = { ...f.ctx, authContext: { ...held, personId: f.person.id, permissions: new Set([...held.permissions].filter(key => !key.startsWith("financial_transaction:"))) } };
    const result = await withTenant(db, f.org, async tx => {
      const input = { taskId: native.task.id, itemKey: "bath_towel", expectedQuantity: "0", expectedRevision: "0", countedQuantity: "3", unit: "pieces",
        catalogRuleId: native.rule.id, catalogVersion: native.rule.version, note: "Retain actual original physical discrepancy" };
      const batch = await prepareFieldStocktakeBatch(ctx, [input], tx);
      return recordFieldStocktakeInTransaction(ctx, input, { deviceId: "actual-variance-device", clientOpId: randomUUID(), clientCreatedAt: null }, tx, batch, { requestId: randomUUID(), ipAddress: null });
    });
    const source = { provider: "INVENTORY" as const, id: result.stocktakeId }, deps = { db, authorizeSource: authorizeVarianceSource };
    const original = () => withTenant(db, f.org, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(s) AS body FROM inventory_stocktake s WHERE id=${source.id}::uuid UNION ALL SELECT id::text,xmin::text,to_jsonb(m) FROM inventory_movement m WHERE stocktake_id=${source.id}::uuid ORDER BY id`);
    const before = await original(), current = await readVarianceWorkflow(ctx, { source }, deps);
    expect(current).toMatchObject({ status: "OPEN", facts: { kind: "QUANTITY", currency: null, expected: "0", actual: "3", variance: "3" } });
    await commandVarianceWorkflow(ctx, { intent: { source, version: current.version, sourceFingerprint: current.sourceFingerprint, operation: "RESOLVE",
      reason: "Authorized operational inspection of actual linen count", action: "Retain original observation and adjustment with attributed explanation" }, idempotencyKey: randomUUID() }, deps);
    expect(await original()).toEqual(before);
    expect(await readVarianceWorkflow(ctx, { source }, deps)).toMatchObject({ status: "RESOLVED" });
    expect(await snapshot(f)).toEqual(originalFinancial);
    const denied = { ...ctx, authContext: { ...ctx.authContext, permissions: new Set([...ctx.authContext.permissions].filter(key => key !== "task:view")) } };
    await expect(readVarianceWorkflow(denied, { source }, deps)).rejects.toThrow();
  });
  it("discloses attributed history only through original source and audit authority and masks broad audit payloads", async () => {
    const f = await fixture();
    await commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps);
    const history = await readVarianceWorkflowHistory(f.ctx, { source: f.source }, f.deps);
    expect(history).toMatchObject({ next: null, rows: [{ version: "1", assignedTo: f.account.id, actorId: f.account.id, reason: f.intent.reason }] });
    const denied = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "audit_log:view")) } };
    await expect(readVarianceWorkflowHistory(denied, { source: f.source }, f.deps)).rejects.toThrow();
    const generic = await listAuditHistory(f.ctx, { resourceType: "variance_workflow_event" }, { db });
    expect(generic.rows).toHaveLength(1);
    expect(generic.rows[0]).toMatchObject({ before: maskedValue, after: maskedValue, reason: maskedValue });
  });
  it("retains an actual bank difference and invalidates its resolution after native release", async () => {
    const f = await actualBankReconciliationFixture(db, admin, ["0.03"]), deps = { db, authorizeSource: authorizeVarianceSource };
    const input = { action: "MATCH" as const, accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.07" }],
      actual: [{ id: f.lines[0].id, amount: "0.03" }], reason: "Review the original actual bank difference", varianceAction: "Retain original bank evidence for review" };
    const review = await reviewBankReconciliation(f.ctx, input, { db });
    const matched = await matchBankStatement(f.ctx, { ...input, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID() }, { db });
    const source = { provider: "BANK" as const, id: matched.id }, before = await snapshot(f);
    const current = await readVarianceWorkflow(f.ctx, { source }, deps);
    expect(current).toMatchObject({ status: "OPEN", facts: { kind: "MONEY", currency: "MAD", expected: "0.07", actual: "0.03", variance: "-0.04" } });
    await commandVarianceWorkflow(f.ctx, { intent: { source, version: current.version, sourceFingerprint: current.sourceFingerprint, operation: "RESOLVE",
      reason: "Authorized officer reviewed actual bank evidence", action: "Retain the original monetary difference and accepted explanation" }, idempotencyKey: randomUUID() }, deps);
    expect(await snapshot(f)).toEqual(before);
    expect(await readVarianceWorkflow(f.ctx, { source }, deps)).toMatchObject({ status: "RESOLVED", resolvedBy: f.account.id });
    await releaseBankReconciliation(f.ctx, { action: "RELEASE", id: matched.id, idempotencyKey: randomUUID(), reason: "Release original allocations for renewed actual bank review" }, { db });
    expect(await readVarianceWorkflow(f.ctx, { source }, deps)).toMatchObject({ status: "SOURCE_CHANGED", version: "1" });
  });
  it("assigns, resolves and reopens through immutable events while preserving every original financial row and version", async () => {
    const f = await fixture(), before = await snapshot(f), assigned = await commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps);
    expect((await readVarianceCenter(f.ctx, { provider: "OTA", assignment: "ME" }, f.deps)).items).toMatchObject([{ detail: { source: f.source, facts: { expected: "0.07", actual: "0.03", variance: "-0.04" } } }]);
    expect(assigned).toMatchObject({ version: "1", operation: "ASSIGN", idempotent: false });
    let current = await readVarianceWorkflow(f.ctx, { source: f.source }, f.deps);
    await commandVarianceWorkflow(f.ctx, { intent: { source: f.source, version: current.version, sourceFingerprint: current.sourceFingerprint, operation: "RESOLVE",
      reason: "Original provider evidence reviewed by the authorized officer", action: "Retain the accepted settlement explanation and original journals" }, idempotencyKey: randomUUID() }, f.deps);
    current = await readVarianceWorkflow(f.ctx, { source: f.source }, f.deps);
    expect(current).toMatchObject({ version: "2", status: "RESOLVED", assignedTo: f.account.id, resolvedBy: f.account.id,
      facts: { kind: "MONEY", expected: "0.07", actual: "0.03", variance: "-0.04", currency: "MAD" } });
    expect(current.resolvedAt).not.toBeNull();
    await commandVarianceWorkflow(f.ctx, { intent: { source: f.source, version: current.version, sourceFingerprint: current.sourceFingerprint, operation: "REOPEN",
      reason: "Additional original provider evidence requires a new review", action: "Investigate while retaining the original attributed resolution" }, idempotencyKey: randomUUID() }, f.deps);
    expect(await readVarianceWorkflow(f.ctx, { source: f.source }, f.deps)).toMatchObject({ version: "3", status: "OPEN", assignedTo: f.account.id, resolvedBy: null, resolvedAt: null });
    expect(await snapshot(f)).toEqual(before);
    await withTenant(db, f.org, async tx => { expect(await tx.varianceWorkflowEvent.count()).toBe(3); expect(await tx.auditLog.count({ where: { resourceType: "variance_workflow_event" } })).toBe(3); });
    await withTenant(db, f.org, async tx => {
      const events = await tx.outboxEvent.findMany({ where: { type: { in: ["VarianceResolved", "VarianceOpened"] } }, orderBy: { occurredAt: "asc" } });
      expect(events.map(event => event.type)).toEqual(["VarianceResolved", "VarianceOpened"]);
      const effects = await tx.varianceWorkflowEvent.findMany({ where: { operation: { in: ["RESOLVE", "REOPEN"] } }, orderBy: { version: "asc" } });
      expect(events.map(event => event.payload)).toEqual(effects.map(effect => ({ varianceWorkflowEventId: effect.id })));
      expect(events.map(event => event.idempotencyKey)).toEqual(effects.map(effect => `variance-workflow:${effect.id}`));
    });
    await expect(withTenant(db, f.org, tx => tx.variance.update({ where: { id: f.source.id }, data: { reason: "Rewrite original money history" } }))).rejects.toThrow("append-only");
  });
  it("acknowledges concurrent exact nonce delivery once and recovers after the caller loses write authority", async () => {
    const f = await fixture(), input = { intent: f.intent, idempotencyKey: randomUUID() }, results = await Promise.all([
      commandVarianceWorkflow(f.ctx, input, f.deps), commandVarianceWorkflow(f.ctx, input, f.deps)]);
    expect(results.map(result => result.idempotent).sort()).toEqual([false, true]); expect(results[0].eventId).toBe(results[1].eventId);
    const readOnly = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:reconcile")) } };
    expect(await commandVarianceWorkflow(readOnly, input, f.deps)).toMatchObject({ eventId: results[0].eventId, idempotent: true });
    expect(await recoverVarianceWorkflow(readOnly, { source: f.source, idempotencyKey: input.idempotencyKey }, f.deps)).toMatchObject({ receipt: { eventId: results[0].eventId } });
    await expect(commandVarianceWorkflow(readOnly, { ...input, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(VarianceWorkflowSourceError);
    await withTenant(db, f.org, async tx => { expect(await tx.varianceWorkflowEvent.count()).toBe(1); expect(await tx.auditLog.count({ where: { resourceType: "variance_workflow_event" } })).toBe(1); });
  });
  it("rejects stale reviews and native source reversals without silently rebasing or rewriting history", async () => {
    const f = await fixture(); await commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps);
    await expect(commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(VarianceWorkflowConflictError);
    await reverseAirbnbSettlement(f.ctx, { settlementId: f.item.settlementId, idempotencyKey: randomUUID(), reason: "Append actual original source opposites before another workflow review" }, { db, requestId: randomUUID(), ipAddress: null });
    const current = await readVarianceWorkflow(f.ctx, { source: f.source }, f.deps); expect(current.status).toBe("SOURCE_CHANGED");
    await expect(commandVarianceWorkflow(f.ctx, { intent: { ...f.intent, version: current.version, sourceFingerprint: current.sourceFingerprint }, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(VarianceWorkflowSourceError);
    expect(await withTenant(db, f.org, tx => tx.varianceWorkflowEvent.count())).toBe(1);
  });
  it("requires independent original financial view and assignment grants and rejects foreign tenant scopes", async () => {
    const f = await fixture(), foreign = await fixture();
    for (const permission of ["financial_transaction:view", "financial_transaction:assign", "financial_transaction:reconcile"]) {
      const denied = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== permission)) } };
      await expect(commandVarianceWorkflow(denied, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(VarianceWorkflowSourceError);
    }
    await expect(readVarianceWorkflow(foreign.ctx, { source: f.source }, f.deps)).rejects.toBeInstanceOf(VarianceWorkflowSourceError);
    expect(await withTenant(db, foreign.org, tx => tx.varianceWorkflowEvent.findMany({ where: { sourceId: f.source.id } }))).toEqual([]);
    expect(await withTenant(db, f.org, tx => tx.varianceWorkflowEvent.count())).toBe(0);
  });
  it("rolls back the event and attributed audit together when the actual audit writer fails", async () => {
    const f = await fixture(), before = await snapshot(f), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { if (event.resourceType === "variance_workflow_event") throw new Error("Actual workflow audit unavailable"); return original(tx, event); });
    try { await expect(commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps)).rejects.toThrow("Actual workflow audit unavailable"); } finally { spy.mockRestore(); }
    expect(await snapshot(f)).toEqual(before); expect(await withTenant(db, f.org, tx => tx.varianceWorkflowEvent.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "variance_workflow_event" } }))).toBe(0);
  });
  it("rechecks independently ended stored authority after the last audit and rolls back all workflow effects", async () => {
    const f = await fixture(), before = await snapshot(f), original = auditWriter.writeAuditEvent; let ended = false;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await original(tx, event);
      if (event.resourceType === "variance_workflow_event") { await withTenant(db, f.org, async current => { const [clock] = await current.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`; await current.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: clock.now } }); }); ended = true; }
      return result;
    });
    try { await expect(commandVarianceWorkflow(f.ctx, { intent: f.intent, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(VarianceWorkflowSourceError); } finally { spy.mockRestore(); }
    expect(ended).toBe(true); expect(await snapshot(f)).toEqual(before); expect(await withTenant(db, f.org, tx => tx.varianceWorkflowEvent.count())).toBe(0);
  });
});
