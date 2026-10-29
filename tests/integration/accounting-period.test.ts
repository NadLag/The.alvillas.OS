import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";
import { closeAccountingPeriod, reopenAccountingPeriod, getAccountingPeriod, listAccountingPeriods } from "@/modules/finance/application/accounting-period-service";
import { accountingPeriodPolicyKey, AccountingPeriodAccessError, AccountingPeriodClosedError, AccountingPeriodConflictError, AccountingPeriodPolicyError } from "@/modules/finance/domain/accounting-period";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { listAuditHistory, exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";
import { Money } from "@/platform/money/money";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
const financialKeys = ["financial_transaction:view", "financial_transaction:configure", "financial_transaction:override", "financial_transaction:export", "audit_log:view", "audit_log:export"];
async function actor(org: string, keys = financialKeys, scope = "organization") {
  const saved = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated period operator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const role = await tx.role.create({ data: { organizationId: org, key: `period_${randomUUID()}`, name: "Dedicated period authority" } });
    const permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, userAccountId: account.id, personId: person.id, roleId: role.id,
      scopeType: scope, scopeId: scope === "organization" ? null : randomUUID(), validFrom: new Date("2020-01-01") } });
    return { person, account, grant };
  });
  return { ...saved, organizationId: org, actorId: saved.account.id, personId: saved.person.id, authContext: await authContextForAccount(org, saved.account.id, { db }) };
}
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated local monthly closing", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db }); const ctx = await actor(org);
  const saved = await withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    await new ConfigRuleRepository(tx, org).createVersion({ key: accountingPeriodPolicyKey, scopeType: "organization", scopeId: null,
      effectiveFrom: new Date("2020-01-01"), reason: "Dedicated explicit period policy", value: { timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 60 } });
    const repo = new FinanceRepository(tx, org), bank = await repo.ensureLedgerAccount({ code: "PERIOD_BANK", name: "Dedicated period bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    const claim = await repo.ensureLedgerAccount({ code: "PERIOD_CLAIM", name: "Dedicated period claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    return { bank, claim };
  });
  return { org, ctx, ...saved, input: { month: "2024-10", expectedVersion: 0, reason: "Dedicated reconciled accounting month", idempotencyKey: randomUUID() } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function post(tx: TenantTransaction, f: Fixture, occurredAt = new Date("2024-10-15T12:00:00Z")) {
  return new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: `Dedicated period journal ${randomUUID()}`, description: "Dedicated fictional period movement", occurredAt,
    idempotencyKey: randomUUID(), createdBy: f.ctx.actorId, postings: [
      { ledgerAccountId: f.bank.id, side: "DEBIT", amount: Money.of("1.01", "MAD"), bucket: "PERIOD_FIXTURE", dimensions: {} },
      { ledgerAccountId: f.claim.id, side: "CREDIT", amount: Money.of("1.01", "MAD"), bucket: "PERIOD_FIXTURE", dimensions: {} }] });
}
async function waitingFor(pid: number, org: string) {
  return withTenant(db, org, async tx => {
    const [row] = await tx.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS waiting`;
    return row.waiting;
  });
}
describe("monthly accounting locks on real PostgreSQL", () => {
  beforeAll(async () => {
    const target = url ? new URL(url) : null, ci = process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true" && target?.pathname === "/alvillas_os";
    if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || ci)) throw Error("Dedicated local PostgreSQL required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(target); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it.each(["CLOSE", "REOPEN"] as const)("holds the selected policy against a concurrent configuration replacement through the actual %s write", async operation => {
    const f = await fixture();
    const closed = operation === "REOPEN" ? await closeAccountingPeriod(f.ctx, f.input, { db }) : null;
    const oldPolicy = await withTenant(db, f.org, tx => new AccountingPeriodRepository(tx, f.org).policy(new Date()));
    let release!: () => void, selected!: () => void, writerStarted!: () => void, writerPid = 0;
    const gate = new Promise<void>(resolve => release = resolve), ready = new Promise<void>(resolve => selected = resolve), writing = new Promise<void>(resolve => writerStarted = resolve);
    const original = Object.getOwnPropertyDescriptor(AccountingPeriodRepository.prototype, "policy")?.value as AccountingPeriodRepository["policy"];
    const hook = vi.spyOn(AccountingPeriodRepository.prototype, "policy").mockImplementation(async function (this: AccountingPeriodRepository, now) {
      const policy = await original.call(this, now); if (policy?.id === oldPolicy!.id) { selected(); await gate; } return policy;
    });
    const pending = (closed ? reopenAccountingPeriod(f.ctx, { periodId: closed.id, expectedVersion: 1, durationSeconds: 30,
      reason: "Concurrent policy update preserves the selected reopening", idempotencyKey: randomUUID() }, { db }) : closeAccountingPeriod(f.ctx, f.input, { db }))
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    await ready;
    const replacement = withTenant(db, f.org, async tx => {
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; writerPid = row.pid; writerStarted();
      return new ConfigRuleRepository(tx, f.org).createVersion({ key: accountingPeriodPolicyKey, scopeType: "organization", scopeId: null,
        effectiveFrom: new Date("2020-01-01"), reason: "Concurrent configured accounting policy replacement", value: { timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 45 } });
    }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await writing;
      await expect.poll(async () => {
        const [row] = await admin.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${writerPid}::integer))>0 AS blocked`;
        return row.blocked;
      }).toBe(true);
    } finally { release(); hook.mockRestore(); }
    const [result, changed] = await Promise.all([pending, replacement]);
    expect(result.ok).toBe(true); if (!result.ok) throw result.error;
    expect(changed.ok).toBe(true); if (!changed.ok) throw changed.error;
    expect(changed.value.id).not.toBe(oldPolicy!.id);
    const detail = await getAccountingPeriod(f.ctx, result.value.id, undefined, { db });
    expect(detail.latest!.policyRuleId).toBe(oldPolicy!.id); expect(detail.rows).toHaveLength(closed ? 2 : 1);
    expect(detail.state).toBe(closed ? "REOPENED" : "CLOSED");
  });

  it("closes once with DST-aware boundaries, an audited complete snapshot and unchanged source rows", async () => {
    const f = await fixture(), original = await withTenant(db, f.org, tx => post(tx, f));
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => closeAccountingPeriod(f.ctx,
      { ...f.input, idempotencyKey: index ? f.input.idempotencyKey : f.input.idempotencyKey.toUpperCase() }, { db })));
    expect(new Set(results.map(row => row.eventId)).size).toBe(1); expect(results.filter(row => !row.idempotent)).toHaveLength(1);
    const detail = await getAccountingPeriod(f.ctx, results[0].id, undefined, { db });
    expect(detail.period.startsAt.toISOString()).toBe("2024-09-30T22:00:00.000Z"); expect(detail.period.endsAt.toISOString()).toBe("2024-10-31T23:00:00.000Z");
    expect(detail.snapshot).toMatchObject({ transactions: 1, postings: 2, unsealed: 0, currencies: [{ currency: "MAD", debit: "1.01", credit: "1.01" }] });
    expect(detail.rows).toHaveLength(1); expect(detail.state).toBe("CLOSED");
    const current = await withTenant(db, f.org, tx => tx.posting.findMany({ where: { transactionId: original.id }, orderBy: { id: "asc" } }));
    expect(current.map(row => row.amount.toString())).toEqual(["1.01", "1.01"]);
    await expect(withTenant(db, f.org, tx => post(tx, f))).rejects.toBeInstanceOf(AccountingPeriodClosedError);
    await expect(withTenant(db, f.org, tx => tx.financialTransaction.create({ data: { organizationId: f.org,
      reference: `Dedicated direct closed-date attempt ${randomUUID()}`, occurredAt: new Date("2024-10-15T12:00:00Z"), createdBy: f.ctx.actorId } })))
      .rejects.toThrow("financial posting date is in a closed accounting period");
    await withTenant(db, f.org, async tx => { await post(tx, f, new Date("2024-09-30T21:59:59.999Z")); await post(tx, f, new Date("2024-10-31T23:00:00.000Z")); });
    await expect(closeAccountingPeriod(f.ctx, { ...f.input, reason: "Changed closing intent" }, { db })).rejects.toBeInstanceOf(AccountingPeriodConflictError);
  });

  it("requires independent current close/reopen rights and denies wrong tenant and scoped grants", async () => {
    const f = await fixture(), closed = await closeAccountingPeriod(f.ctx, f.input, { db });
    const reader = await actor(f.org, ["financial_transaction:view"]), closer = await actor(f.org, ["financial_transaction:view", "financial_transaction:configure"]);
    expect((await listAccountingPeriods(reader, {}, { db })).rows).toHaveLength(1);
    await expect(closeAccountingPeriod(reader, { ...f.input, month: "2024-09", idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(AccountingPeriodAccessError);
    const request = { periodId: closed.id, expectedVersion: 1, durationSeconds: 30, reason: "Dedicated privileged correction", idempotencyKey: randomUUID() };
    await expect(reopenAccountingPeriod(closer, request, { db })).rejects.toBeInstanceOf(AccountingPeriodAccessError);
    for (const scope of ["owner", "property"]) await expect(listAccountingPeriods(await actor(f.org, financialKeys, scope), {}, { db })).rejects.toBeInstanceOf(AccountingPeriodAccessError);
    const other = await fixture(); await expect(getAccountingPeriod(other.ctx, closed.id, undefined, { db })).rejects.toBeInstanceOf(AccountingPeriodAccessError);
    expect(await withTenant(db, other.org, tx => tx.accountingPeriod.count())).toBe(0);
    expect(await db.accountingPeriod.count()).toBe(0);
    const rollback = new Error("Retain policies after the isolated permissive-policy regression");
    await expect(admin.$transaction(async tx => {
      await tx.$executeRawUnsafe("CREATE POLICY accounting_period_test_permissive ON accounting_period USING (true) WITH CHECK (true)");
      await tx.$executeRawUnsafe("CREATE POLICY accounting_period_event_test_permissive ON accounting_period_event USING (true) WITH CHECK (true)");
      await tx.$executeRawUnsafe("SET LOCAL ROLE alvillas_ops_tests");
      await tx.$queryRaw`SELECT set_config('app.current_organization_id', ${other.org}, true)`;
      expect(await tx.accountingPeriod.count({ where: { id: closed.id } })).toBe(0);
      expect(await tx.accountingPeriodEvent.count({ where: { periodId: closed.id } })).toBe(0);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("expires a configured reopening window and never extends it on a late duplicate", async () => {
    const f = await fixture(), closed = await closeAccountingPeriod(f.ctx, f.input, { db });
    const input = { periodId: closed.id, expectedVersion: 1, durationSeconds: 2, reason: "Dedicated bounded correction", idempotencyKey: randomUUID() };
    await expect(reopenAccountingPeriod(f.ctx, { ...input, durationSeconds: 61 }, { db })).rejects.toBeInstanceOf(AccountingPeriodPolicyError);
    const opened = await reopenAccountingPeriod(f.ctx, input, { db });
    const first = await getAccountingPeriod(f.ctx, closed.id, undefined, { db }); expect(first.state).toBe("REOPENED");
    await withTenant(db, f.org, tx => post(tx, f));
    await expect.poll(async () => (await getAccountingPeriod(f.ctx, closed.id, undefined, { db })).state, { timeout: 6000 }).toBe("CLOSED");
    expect((await reopenAccountingPeriod(f.ctx, input, { db })).eventId).toBe(opened.eventId);
    const after = await getAccountingPeriod(f.ctx, closed.id, undefined, { db }); expect(after.state).toBe("CLOSED"); expect(after.rows).toHaveLength(2);
    expect(after.latest?.reopensUntil).toEqual(first.latest?.reopensUntil);
    await expect(withTenant(db, f.org, tx => post(tx, f))).rejects.toBeInstanceOf(AccountingPeriodClosedError);
  });

  it("waits for an in-flight writer and includes it before closing", async () => {
    const f = await fixture(); let release!: () => void, acquired!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { acquired = resolve; });
    const writer = withTenant(db, f.org, async tx => { await post(tx, f); const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; acquired(connection.pid); await gate; });
    const pid = await ready, pending = closeAccountingPeriod(f.ctx, f.input, { db });
    try { await expect.poll(() => waitingFor(pid, f.org)).toBe(true); } finally { release(); await writer; }
    const closed = await pending; expect((await getAccountingPeriod(f.ctx, closed.id, undefined, { db })).snapshot.transactions).toBe(1);
  });

  it("makes a queued new writer observe the committed closed period", async () => {
    const f = await fixture(); let release!: () => void, acquired!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { acquired = resolve; });
    const closer = withTenant(db, f.org, async tx => {
      await closeAccountingPeriod(f.ctx, f.input, { db: { $transaction: work => work(tx) } });
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; acquired(connection.pid); await gate;
    });
    const pid = await ready, pending = withTenant(db, f.org, tx => post(tx, f)).then(value => ({ value }), error => ({ error: error as unknown }));
    try { await expect.poll(() => waitingFor(pid, f.org)).toBe(true); } finally { release(); await closer; }
    const result = await pending; expect("error" in result ? result.error : null).toBeInstanceOf(AccountingPeriodClosedError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });

  it("checks grant revocation after waiting for the actual exclusive period lock", async () => {
    const f = await fixture(); let release!: () => void, acquired!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { acquired = resolve; });
    const holder = withTenant(db, f.org, async tx => { await new AccountingPeriodRepository(tx, f.org).lock();
      const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; acquired(connection.pid); await gate; });
    const pid = await ready, pending = closeAccountingPeriod(f.ctx, f.input, { db }).then(value => ({ value }), error => ({ error: error as unknown }));
    try { await expect.poll(() => waitingFor(pid, f.org)).toBe(true); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.ctx.grant.id }, data: { validTo: new Date("2025-01-01") } })); }
    finally { release(); await holder; }
    const result = await pending; expect("error" in result ? result.error : null).toBeInstanceOf(AccountingPeriodAccessError);
    expect(await withTenant(db, f.org, tx => tx.accountingPeriod.count())).toBe(0);
  });

  it("enforces immutable history, exact snapshots, policy limits and atomic audit directly in PostgreSQL", async () => {
    const f = await fixture(), closed = await closeAccountingPeriod(f.ctx, f.input, { db });
    const row = await getAccountingPeriod(f.ctx, closed.id, undefined, { db });
    await expect(withTenant(db, f.org, tx => tx.accountingPeriod.update({ where: { id: closed.id }, data: { timezone: "UTC" } }))).rejects.toThrow("append-only");
    await expect(withTenant(db, f.org, tx => tx.accountingPeriodEvent.delete({ where: { id: closed.eventId } }))).rejects.toThrow("append-only");
    for (const invalid of ["snapshot", "duration", "audit"]) await expect(withTenant(db, f.org, async tx => {
      const repo = new AccountingPeriodRepository(tx, f.org), policy = (await repo.policy(await new FinanceRepository(tx, f.org).clock()))!;
      return repo.createEvent({ periodId: closed.id, version: 2, kind: "REOPEN", reason: "Dedicated direct integrity attempt", idempotencyKey: randomUUID(), previousEventId: closed.eventId,
        reopenSeconds: invalid === "duration" ? 61 : 30, policyRuleId: policy.id, snapshot: invalid === "snapshot" ? { ...row.snapshot, financialHash: "0".repeat(64) } : row.snapshot, createdBy: f.ctx.actorId });
    })).rejects.toThrow(invalid === "snapshot" ? "snapshot must match" : invalid === "duration" ? "window is invalid" : "audit must commit atomically");
    const other = await fixture();
    await expect(withTenant(db, other.org, tx => tx.accountingPeriodEvent.create({ data: { organizationId: other.org, periodId: closed.id, version: 2, kind: "REOPEN", reason: "Dedicated foreign source", idempotencyKey: randomUUID(), previousEventId: closed.eventId,
      reopenSeconds: 10, policyRuleId: row.latest!.policyRuleId, snapshot: row.snapshot, createdBy: other.ctx.actorId } }))).rejects.toThrow();
    expect((await getAccountingPeriod(f.ctx, closed.id, undefined, { db })).rows).toHaveLength(1);
  });

  it("masks period snapshots and reasons without independent financial audit view/export", async () => {
    const f = await fixture(); await closeAccountingPeriod(f.ctx, f.input, { db });
    const operational = await actor(f.org, ["audit_log:view", "audit_log:export"]);
    const hidden = await listAuditHistory(operational, { resourceType: "accounting_period" }, { db });
    expect(hidden.rows).toHaveLength(1); expect(hidden.rows[0].after).toBe(maskedValue); expect(hidden.rows[0].reason).toBe(maskedValue);
    expect(await exportAuditHistoryCsv(operational, { resourceType: "accounting_period" }, { db })).not.toContain("financialHash");
    const visible = await listAuditHistory(f.ctx, { resourceType: "accounting_period" }, { db }); expect(JSON.stringify(visible.rows[0].after)).toContain("financialHash");
  });
});
