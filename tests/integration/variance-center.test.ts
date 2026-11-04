import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { readVarianceCenter } from "@/modules/finance/application/variance-center-service";
import { readVarianceWorkflow, commandVarianceWorkflow } from "@/modules/finance/application/variance-workflow-service";
import { VarianceCenterAccessError, VarianceCenterCursorError } from "@/modules/finance/domain/variance-center";
import { authorizeVarianceSource } from "@/platform/reconciliation/variance-source-authority";
import { prepareFieldStocktakeBatch, recordFieldStocktakeInTransaction } from "@/platform/inventory/field-stocktake-service";
import * as auditWriter from "@/platform/audit/audit-writer";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";
import { transactionQueryMeasurement } from "./support/transaction-query-measurement";
import { actualBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import { reviewBankReconciliation, matchBankStatement } from "@/modules/finance/application/bank-reconciliation-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient, measurement: ReturnType<typeof transactionQueryMeasurement>;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated variance center database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const scoped = new URL(url!); scoped.username = scoped.password = "alvillas_ops_tests";
  const observed = new PrismaClient({ datasourceUrl: scoped.toString(), log: [{ emit: "event", level: "query" }] }); measurement = transactionQueryMeasurement(observed); observed.$on("query", event => measurement.observe(event.query)); db = observed;
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });
const deps = () => ({ db, authorizeSource: authorizeVarianceSource });
const money = (org: string) => withTenant(db, org, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${org}::uuid UNION ALL SELECT id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${org}::uuid ORDER BY id`);

async function fixture(count = 1) {
  const f = await actualGuestDepositFixture(db, admin), originalMoney = await money(f.org);
  const rule = await withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["task:view", "task:edit", "task:assign"] } } }); expect(permissions).toHaveLength(3);
    await tx.rolePermission.createMany({ data: permissions.map(row => ({ organizationId: f.org, roleId: f.role.id, permissionId: row.id })), skipDuplicates: true });
    return new ConfigRuleRepository(tx, f.org).createVersion({ key: "inventory.minimums", scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      value: { minimums: [{ item: "bath_towel", quantity: 8, category: "LINEN", unit: "pieces", name: { en: "Bath towel", fr: "Serviette", ar: "منشفة" } }] },
      createdBy: f.account.id, reason: "Actual organization stocktake catalog for private variance center acceptance" });
  });
  const loaded = await authContextForAccount(f.org, f.account.id, { db });
  const ctx = { ...f.ctx, authContext: { ...loaded, personId: f.person.id, permissions: new Set([...loaded.permissions].filter(key => !key.startsWith("financial_transaction:"))) } };
  const ids: string[] = [];
  const append = async (size: number) => {
    for (let offset = 0; offset < size; offset += 20) {
      const batchIds = Array.from({ length: Math.min(20, size - offset) }, () => ({ propertyId: randomUUID(), taskId: randomUUID() }));
      const recorded = await withTenant(db, f.org, async tx => {
        await tx.property.createMany({ data: batchIds.map(row => ({ id: row.propertyId, organizationId: f.org, name: "Actual observed variance villa " + row.propertyId,
          addressLine1: "Test", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] })) });
        await tx.operationTask.createMany({ data: batchIds.map(row => ({ id: row.taskId, organizationId: f.org, propertyId: row.propertyId,
          assignedToUserAccountId: f.account.id, assignedToPersonId: f.person.id, state: "ASSIGNED", type: "INSPECTION", dueDate: new Date("2031-05-01"),
          titleTranslations: { en: "Observe actual linen", fr: "Compter le linge" }, idempotencyKey: randomUUID(), createdBy: f.account.id })) });
        const inputs = batchIds.map(row => ({ taskId: row.taskId, itemKey: "bath_towel", expectedQuantity: "0", expectedRevision: "0", countedQuantity: "3", unit: "pieces",
          catalogRuleId: rule.id, catalogVersion: rule.version, note: "Original observed physical difference for attributed follow-up" }));
        const batch = await prepareFieldStocktakeBatch(ctx, inputs, tx), results = [];
        for (const input of inputs) results.push(await recordFieldStocktakeInTransaction(ctx, input, { deviceId: "actual-center-device", clientOpId: randomUUID(), clientCreatedAt: null }, tx, batch, { requestId: randomUUID(), ipAddress: null }));
        return results;
      });
      ids.push(...recorded.map(row => row.stocktakeId));
    }
  };
  await append(count); return { ...f, ctx, rule, ids, append, originalMoney };
}

describe("bounded native organization variance center", () => {
  it("lists only the actual original bank association with its authorized exact difference", async () => {
    const f = await actualBankReconciliationFixture(db, admin, ["0.03"]);
    const input = { action: "MATCH" as const, accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.07" }], actual: [{ id: f.lines[0].id, amount: "0.03" }],
      reason: "Retain actual original bank difference for center acceptance", varianceAction: "Review original bank evidence without changing money" };
    const reviewed = await reviewBankReconciliation(f.ctx, input, { db }), match = await matchBankStatement(f.ctx, { ...input, reviewFingerprint: reviewed.reviewFingerprint, idempotencyKey: randomUUID() }, { db });
    const before = await money(f.org), page = await readVarianceCenter(f.ctx, { provider: "BANK" }, deps());
    expect(page).toMatchObject({ next: null, items: [{ reference: f.banks.receipt.name, detail: { source: { provider: "BANK", id: match.id }, facts: { kind: "MONEY", currency: "MAD", expected: "0.07", actual: "0.03", variance: "-0.04" } } }] });
    expect(await money(f.org)).toEqual(before);
  });
  it("pages all500 actual property observations with constant per-page queries and unchanged original financial history", async () => {
    const f = await fixture(20), input = { provider: "INVENTORY" };
    const small = await measurement.measure(() => readVarianceCenter(f.ctx, input, deps())); expect(small.value.items).toHaveLength(20); expect(small.value.next).toBeNull();
    await f.append(480);
    const started = performance.now(), large = await measurement.measure(() => readVarianceCenter(f.ctx, input, deps()));
    expect(large.value.items).toHaveLength(20); expect(large.value.next).not.toBeNull(); expect(large.count).toBe(small.count);
    expect(large.value.items.map(row => row.detail.source.id)).toEqual(small.value.items.map(row => row.detail.source.id));
    const observed = large.value.items.map(row => row.detail.source.id); let cursor = large.value.next, pages = 1;
    while (cursor) { const next = await readVarianceCenter(f.ctx, { ...input, cursor }, deps()); observed.push(...next.items.map(row => row.detail.source.id)); cursor = next.next; pages++; }
    expect(pages).toBe(25); expect(new Set(observed).size).toBe(500); expect([...observed].sort()).toEqual([...f.ids].sort());
    expect(await money(f.org)).toEqual(f.originalMoney);
    console.log(JSON.stringify({ actualProperties: 500, nativeObservations: observed.length, pageQueries: large.count, pages, browseMilliseconds: Math.round(performance.now() - started), originalFinancialHistoryUnchanged: true }));
  });
  it("filters actual assignment and resolution without granting access through assignment or another tenant", async () => {
    const f = await fixture(), foreign = await fixture(), source = { provider: "INVENTORY" as const, id: f.ids[0] };
    let current = await readVarianceWorkflow(f.ctx, { source }, deps());
    await commandVarianceWorkflow(f.ctx, { intent: { source, version: current.version, sourceFingerprint: current.sourceFingerprint, operation: "ASSIGN", assignedTo: f.account.id, reason: "Assign actual observed operational follow-up" }, idempotencyKey: randomUUID() }, deps());
    expect((await readVarianceCenter(f.ctx, { provider: "INVENTORY", assignment: "ME" }, deps())).items.map(row => row.detail.source.id)).toEqual([source.id]);
    expect((await readVarianceCenter(f.ctx, { provider: "INVENTORY", assignment: "UNASSIGNED" }, deps())).items).toEqual([]);
    current = await readVarianceWorkflow(f.ctx, { source }, deps());
    await commandVarianceWorkflow(f.ctx, { intent: { source, version: current.version, sourceFingerprint: current.sourceFingerprint, operation: "RESOLVE", reason: "Actual officer reviewed the original physical observation", action: "Retain the original movement and accepted operational explanation" }, idempotencyKey: randomUUID() }, deps());
    expect((await readVarianceCenter(f.ctx, { provider: "INVENTORY" }, deps())).items).toEqual([]);
    expect((await readVarianceCenter(f.ctx, { provider: "INVENTORY", status: "RESOLVED" }, deps())).items).toMatchObject([{ detail: { source, resolvedBy: f.account.id } }]);
    expect((await readVarianceCenter(foreign.ctx, { provider: "INVENTORY", status: "ALL" }, deps())).items.every(row => row.detail.source.id !== source.id)).toBe(true);
    const denied = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "task:view")) } };
    await expect(readVarianceCenter(denied, { provider: "INVENTORY" }, deps())).rejects.toBeInstanceOf(VarianceCenterAccessError);
    await expect(readVarianceCenter(f.ctx, { provider: "BANK" }, deps())).rejects.toBeInstanceOf(VarianceCenterAccessError);
    const observation = await withTenant(db, f.org, tx => tx.inventoryStocktake.findUniqueOrThrow({ where: { id: source.id } }));
    const scoped = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: undefined, scopes: [{ organizationId: f.org, scopeType: "job" as const, scopeId: observation.taskId! }] } };
    expect(await readVarianceWorkflow(scoped, { source }, deps())).toMatchObject({ source, status: "RESOLVED" });
    await expect(readVarianceCenter(scoped, { provider: "INVENTORY" }, deps())).rejects.toBeInstanceOf(VarianceCenterAccessError);
  });
  it("binds continuation to the original actor, filters and independent current scope", async () => {
    const f = await fixture(21), foreign = await fixture(), first = await readVarianceCenter(f.ctx, { provider: "INVENTORY" }, deps()); expect(first.next).not.toBeNull();
    await expect(readVarianceCenter(f.ctx, { provider: "INVENTORY", status: "ALL", cursor: first.next }, deps())).rejects.toBeInstanceOf(VarianceCenterCursorError);
    await expect(readVarianceCenter(foreign.ctx, { provider: "INVENTORY", cursor: first.next }, deps())).rejects.toBeInstanceOf(VarianceCenterCursorError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { validFrom: new Date("2019-01-01") } }));
    await expect(readVarianceCenter(f.ctx, { provider: "INVENTORY", cursor: first.next }, deps())).rejects.toBeInstanceOf(VarianceCenterCursorError);
  });
  it("rechecks ended stored authority after the queue audit and rolls back disclosure evidence", async () => {
    const f = await fixture(), original = auditWriter.writeAuditEvent; let ended = false;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const saved = await original(tx, event);
      if (event.resourceType === "variance_workflow_queue") {
        await withTenant(db, f.org, async current => { await current.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: await new FinanceRepository(current, f.org).clock() } }); }); ended = true;
      }
      return saved;
    });
    try { await expect(readVarianceCenter(f.ctx, { provider: "INVENTORY" }, deps())).rejects.toThrow(); } finally { spy.mockRestore(); }
    expect(ended).toBe(true);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "variance_workflow_queue" } }))).toBe(0);
    expect(await money(f.org)).toEqual(f.originalMoney);
  });
});
