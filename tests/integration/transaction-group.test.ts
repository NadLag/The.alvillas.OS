import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { TransactionGroupRepository } from "@/modules/finance/infrastructure/transaction-group-repository";
import { createTransactionGroup, changeTransactionGroupMembership, getTransactionGroup, listTransactionGroups,
  TransactionGroupAccessError, TransactionGroupConflictError } from "@/modules/finance/application/transaction-group-service";
import { listAuditHistory, exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { maskedValue } from "@/platform/authz/present";
import { Money } from "@/platform/money/money";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
const permissions = ["financial_transaction:view", "financial_transaction:configure", "financial_transaction:export", "audit_log:view", "audit_log:export"];
async function actor(org: string, keys = permissions, scope = "organization", cap?: string) {
  const saved = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated group actor" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const role = await tx.role.create({ data: { organizationId: org, key: `group_${randomUUID()}`, name: "Dedicated group access" } });
    const found = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } }); expect(found).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: found.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, userAccountId: account.id, personId: person.id,
      roleId: role.id, scopeType: scope, scopeId: scope === "organization" ? null : randomUUID(), validFrom: new Date("2020-01-01"),
      ...(cap ? { conditions: { maxAmount: cap } } : {}) } });
    return { person, account, grant };
  });
  return { ...saved, organizationId: org, actorId: saved.account.id, personId: saved.person.id, authContext: await authContextForAccount(org, saved.account.id, { db }) };
}
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated local transaction groups", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db }); const ctx = await actor(org);
  const journal = await withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const repo = new FinanceRepository(tx, org);
    const bank = await repo.ensureLedgerAccount({ code: "GROUP_BANK", name: "Dedicated group bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    const owner = await repo.ensureLedgerAccount({ code: "GROUP_OWNER", name: "Dedicated owner claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    return repo.createFinancialTransaction({ reference: `Dedicated group receipt ${randomUUID()}`, description: "Dedicated fictional grouped receipt", occurredAt: new Date(),
      idempotencyKey: randomUUID(), createdBy: ctx.actorId, postings: [
        { ledgerAccountId: bank.id, side: "DEBIT", amount: Money.of("100.01", "MAD"), bucket: "GROUP_FIXTURE", dimensions: {} },
        { ledgerAccountId: owner.id, side: "CREDIT", amount: Money.of("100.01", "MAD"), bucket: "GROUP_FIXTURE", dimensions: {} }] });
  });
  const input = { name: "Dedicated private financial group", reason: "Dedicated grouping acceptance", idempotencyKey: randomUUID() };
  return { org, ctx, journal, input };
}
async function financialFacts(org: string) {
  return withTenant(db, org, async tx => ({ headers: await tx.financialTransaction.findMany({ orderBy: { id: "asc" } }), postings: await tx.posting.findMany({ orderBy: { id: "asc" } }) }));
}

describe("transaction groups on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it("creates and attaches exactly once across concurrent retries without changing journal facts", async () => {
    const f = await fixture(), before = await financialFacts(f.org);
    const groups = await Promise.all(Array.from({ length: 4 }, (_, index) => createTransactionGroup(f.ctx,
      { ...f.input, idempotencyKey: index ? f.input.idempotencyKey : f.input.idempotencyKey.toUpperCase() }, { db })));
    expect(new Set(groups.map(row => row.id)).size).toBe(1);
    const input = { groupId: groups[0].id, transactionId: f.journal.id, previousEntryId: null, action: "ATTACH", reason: "Dedicated receipt association", idempotencyKey: randomUUID() };
    const entries = await Promise.all(Array.from({ length: 4 }, () => changeTransactionGroupMembership(f.ctx, input, { db })));
    expect(new Set(entries.map(row => row.id)).size).toBe(1);
    const result = await getTransactionGroup(f.ctx, groups[0].id, {}, { db });
    expect(result.members.rows).toHaveLength(1); expect(result.history.rows).toHaveLength(1);
    expect(result.movements.map(row => row.amount)).toEqual(["100.01", "100.01"]);
    expect(new Set(result.movements.map(row => row.accountType))).toEqual(new Set(["ASSET_LOCATION", "CLAIM_OWNERSHIP"]));
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "transaction_group" } }))).toBe(2);
    expect(await financialFacts(f.org)).toEqual(before);
    await expect(createTransactionGroup(f.ctx, { ...f.input, name: "Changed retry facts" }, { db })).rejects.toBeInstanceOf(TransactionGroupConflictError);
    await expect(changeTransactionGroupMembership(f.ctx, { ...input, reason: "Changed retry reason" }, { db })).rejects.toBeInstanceOf(TransactionGroupConflictError);
  });

  it("serializes competing groups and retains reasoned detach/move history and old acknowledgements", async () => {
    const f = await fixture(), before = await financialFacts(f.org);
    const first = await createTransactionGroup(f.ctx, f.input, { db });
    const second = await createTransactionGroup(f.ctx, { ...f.input, name: "Second dedicated group", idempotencyKey: randomUUID() }, { db });
    const requests = [first, second].map(group => ({ groupId: group.id, transactionId: f.journal.id, previousEntryId: null, action: "ATTACH", reason: "Dedicated concurrent association", idempotencyKey: randomUUID() }));
    const results = await Promise.allSettled(requests.map(input => changeTransactionGroupMembership(f.ctx, input, { db })));
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(row => row.status === "rejected");
    expect(rejected?.reason as unknown).toBeInstanceOf(TransactionGroupConflictError);
    const current = await withTenant(db, f.org, tx => new TransactionGroupRepository(tx, f.org).currentEntry(f.journal.id)); expect(current).toBeTruthy();
    const winner = requests.find(row => row.groupId === current!.groupId)!, target = requests.find(row => row.groupId !== current!.groupId)!;
    const detached = await changeTransactionGroupMembership(f.ctx, { ...winner, previousEntryId: current!.id, action: "DETACH", reason: "Correct dedicated group selection", idempotencyKey: randomUUID() }, { db });
    await changeTransactionGroupMembership(f.ctx, { ...target, previousEntryId: detached.id, idempotencyKey: randomUUID() }, { db });
    expect(await changeTransactionGroupMembership(f.ctx, winner, { db })).toEqual({ id: current!.id });
    await expect(changeTransactionGroupMembership(f.ctx, { ...winner, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(TransactionGroupConflictError);
    expect((await getTransactionGroup(f.ctx, winner.groupId, {}, { db })).members.rows).toHaveLength(0);
    expect((await getTransactionGroup(f.ctx, winner.groupId, {}, { db })).movements).toEqual([]);
    expect((await getTransactionGroup(f.ctx, target.groupId, {}, { db })).members.rows).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => tx.transactionGroupEntry.count())).toBe(3);
    expect(await financialFacts(f.org)).toEqual(before);
  });

  it("denies operational, property-scoped, capped, configure-only and revoked grants", async () => {
    const f = await fixture();
    for (const [keys, scope, cap] of [[permissions, "property", undefined], [permissions, "organization", "9000"],
      [["task:view"], "organization", undefined], [["financial_transaction:configure"], "organization", undefined]] as const) {
      const restricted = await actor(f.org, [...keys], scope, cap);
      await expect(createTransactionGroup(restricted, { ...f.input, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
      await expect(listTransactionGroups(restricted, {}, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
    }
    const reader = await actor(f.org, ["financial_transaction:view"]);
    expect((await listTransactionGroups(reader, {}, { db })).canConfigure).toBe(false);
    await expect(createTransactionGroup(reader, f.input, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.ctx.grant.id }, data: { validTo: new Date("2025-01-01") } }));
    await expect(createTransactionGroup(f.ctx, f.input, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
  });

  it("keeps tenants isolated and refuses foreign groups, journals and actor contexts", async () => {
    const f = await fixture(), other = await fixture(), group = await createTransactionGroup(f.ctx, f.input, { db });
    expect((await listTransactionGroups(other.ctx, {}, { db })).rows).toHaveLength(0);
    await expect(getTransactionGroup(other.ctx, group.id, {}, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
    for (const [ctx, transactionId] of [[other.ctx, other.journal.id], [f.ctx, other.journal.id]] as const)
      await expect(changeTransactionGroupMembership(ctx, { groupId: group.id, transactionId, previousEntryId: null, action: "ATTACH", reason: "Dedicated foreign source denial", idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
    await expect(listTransactionGroups({ ...other.ctx, organizationId: f.org }, {}, { db })).rejects.toBeInstanceOf(TransactionGroupAccessError);
    expect(await db.transactionGroup.count()).toBe(0);
    expect(await withTenant(db, other.org, tx => tx.transactionGroup.count({ where: { organizationId: f.org } }))).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.transactionGroupEntry.count())).toBe(0);
  });

  it("enforces append-only metadata and atomic audits directly at the database", async () => {
    const f = await fixture(), group = await createTransactionGroup(f.ctx, f.input, { db });
    const input = { groupId: group.id, transactionId: f.journal.id, previousEntryId: null, action: "ATTACH", reason: "Dedicated group association", idempotencyKey: randomUUID() };
    const entry = await changeTransactionGroupMembership(f.ctx, input, { db });
    await expect(withTenant(db, f.org, tx => tx.transactionGroup.update({ where: { id: group.id }, data: { name: "Forbidden rewrite" } }))).rejects.toThrow("append-only");
    await expect(withTenant(db, f.org, tx => tx.transactionGroupEntry.delete({ where: { id: entry.id } }))).rejects.toThrow("append-only");
    await expect(withTenant(db, f.org, tx => tx.transactionGroup.create({ data: { organizationId: f.org, name: "Missing audit", reason: "Dedicated missing group audit", idempotencyKey: randomUUID(), createdBy: f.ctx.actorId } }))).rejects.toThrow("audit must commit atomically");
    await expect(withTenant(db, f.org, tx => tx.transactionGroupEntry.create({ data: { ...input, organizationId: f.org, createdBy: f.ctx.actorId,
      previousEntryId: entry.id, action: "DETACH", idempotencyKey: randomUUID() } }))).rejects.toThrow("audit must commit atomically");
    expect(await withTenant(db, f.org, tx => tx.transactionGroupEntry.count())).toBe(1);
  });

  it("masks group names, membership and reasons without independent financial audit rights", async () => {
    const f = await fixture(), group = await createTransactionGroup(f.ctx, f.input, { db });
    await changeTransactionGroupMembership(f.ctx, { groupId: group.id, transactionId: f.journal.id, previousEntryId: null, action: "ATTACH", reason: "Dedicated private association", idempotencyKey: randomUUID() }, { db });
    const operational = await actor(f.org, ["audit_log:view", "audit_log:export"]), filters = { resourceType: "transaction_group" };
    const hidden = await listAuditHistory(operational, filters, { db });
    expect(hidden.rows).toHaveLength(2);
    for (const row of hidden.rows) { expect(row.after).toBe(maskedValue); expect(row.reason).toBe(maskedValue); }
    expect(await exportAuditHistoryCsv(operational, filters, { db })).not.toContain(f.input.name);
    expect(JSON.stringify(await listAuditHistory(f.ctx, filters, { db }))).toContain(f.input.name);
    expect(await exportAuditHistoryCsv(f.ctx, filters, { db })).toContain(f.input.name);
  });

  it("prevents competing membership roots even when callers use the database directly", async () => {
    const f = await fixture();
    const groups = [await createTransactionGroup(f.ctx, f.input, { db }),
      await createTransactionGroup(f.ctx, { ...f.input, name: "Competing direct database group", idempotencyKey: randomUUID() }, { db })];
    const results = await Promise.allSettled(groups.map(group => withTenant(db, f.org, async tx => {
      const entry = await tx.transactionGroupEntry.create({ data: { organizationId: f.org, groupId: group.id, transactionId: f.journal.id,
        previousEntryId: null, action: "ATTACH", reason: "Dedicated direct concurrency proof", idempotencyKey: randomUUID(), createdBy: f.ctx.actorId } });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.ctx.actorId, action: "finance.group.attached", resourceType: "transaction_group",
        resourceId: group.id, after: { entryId: entry.id, transactionId: f.journal.id }, reason: entry.reason, requestId: randomUUID(), occurredAt: new Date() });
      return entry;
    })));
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => tx.transactionGroupEntry.count())).toBe(1);
  });

  it("paginates complete membership and history while deriving movements beyond the first page", async () => {
    const f = await fixture(), group = await createTransactionGroup(f.ctx, f.input, { db });
    await withTenant(db, f.org, async tx => {
      const finance = new FinanceRepository(tx, f.org);
      for (let index = 0; index < 51; index += 1) {
        const journal = await finance.createFinancialTransaction({ reference: `Dedicated paged group ${index}`, description: "Dedicated exact group pagination", occurredAt: new Date(),
          createdBy: f.ctx.actorId, idempotencyKey: randomUUID(), postings: f.journal.postings.map(line => ({ ledgerAccountId: line.ledgerAccountId, side: line.side as "DEBIT" | "CREDIT",
            amount: Money.of("0.01", "MAD"), bucket: "GROUP_PAGE", dimensions: {} })) });
        const entry = await tx.transactionGroupEntry.create({ data: { organizationId: f.org, groupId: group.id, transactionId: journal.id,
          action: "ATTACH", reason: "Dedicated complete page membership", idempotencyKey: randomUUID(), createdBy: f.ctx.actorId } });
        await writeAuditEvent(tx, { organizationId: f.org, actorId: f.ctx.actorId, action: "finance.group.attached", resourceType: "transaction_group", resourceId: group.id,
          after: { entryId: entry.id, transactionId: journal.id }, reason: entry.reason, requestId: randomUUID(), occurredAt: new Date() });
      }
    });
    const first = await getTransactionGroup(f.ctx, group.id, {}, { db });
    expect(first.members.rows).toHaveLength(50); expect(first.history.rows).toHaveLength(50);
    expect(first.members.next).toBeTruthy(); expect(first.history.next).toBeTruthy();
    expect(first.movements.map(row => row.amount)).toEqual(["0.51", "0.51"]);
    const second = await getTransactionGroup(f.ctx, group.id, { membersAfter: first.members.next, historyAfter: first.history.next }, { db });
    expect(second.members.rows).toHaveLength(1); expect(second.history.rows).toHaveLength(1);
    expect(new Set([...first.history.rows, ...second.history.rows].map(row => row.id)).size).toBe(51);
    expect(second.members.next).toBeUndefined(); expect(second.history.next).toBeUndefined();
    expect(second.candidates.rows.map(row => row.id)).toEqual([f.journal.id]);
    expect((await getTransactionGroup(f.ctx, group.id, { historyAfter: randomUUID() }, { db })).history.rows).toHaveLength(0);
  });

  it("rechecks grant revocation after waiting for the real transaction membership lock", async () => {
    const f = await fixture(), group = await createTransactionGroup(f.ctx, f.input, { db });
    const input = { groupId: group.id, transactionId: f.journal.id, previousEntryId: null, action: "ATTACH", reason: "Dedicated waited permission proof", idempotencyKey: randomUUID() };
    let release!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { acquired = resolve; });
    const holder = withTenant(db, f.org, async tx => { await new TransactionGroupRepository(tx, f.org).lockTransaction(f.journal.id); acquired(); await gate; });
    await ready;
    const pending = changeTransactionGroupMembership(f.ctx, input, { db }).then(value => ({ value }), error => ({ error: error as unknown }));
    try {
      await expect.poll(() => withTenant(db, f.org, async tx => {
        const result = await tx.$queryRaw<Array<{ available: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${f.org + ":transaction-group-request:" + input.idempotencyKey},0)) AS available`;
        return result[0].available;
      })).toBe(false);
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.ctx.grant.id }, data: { validTo: new Date("2025-01-01") } }));
    } finally { release(); await holder; }
    const outcome = await pending;
    expect("error" in outcome ? outcome.error : null).toBeInstanceOf(TransactionGroupAccessError);
    expect(await withTenant(db, f.org, tx => tx.transactionGroupEntry.count())).toBe(0);
  });
});
