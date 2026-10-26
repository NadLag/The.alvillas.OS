import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { pushSyncOps } from "@/modules/reservations/application/sync-service";
import { syncPushInputSchema } from "@/modules/reservations/domain/sync-protocol";
import { pullFieldWork } from "@/modules/reservations/application/field-pull-service";
import { fieldPullInputSchema } from "@/modules/reservations/domain/field-pull";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import { AuditRepository } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Native field cash integration", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    for (const currency of [{ code: "MAD", name: "Dirham", minorUnit: 2 }, { code: "EUR", name: "Euro", minorUnit: 2 }, { code: "JPY", name: "Yen", minorUnit: 0 }])
      await tx.currency.upsert({ where: { code: currency.code }, update: {}, create: currency });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated cash driver" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Cash receipt villa", addressLine1: "Local integration",
      city: "Marrakech", region: "Marrakech-Safi", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const task = await tx.operationTask.create({ data: { organizationId: org, propertyId: property.id, assignedToUserAccountId: account.id,
      assignedToPersonId: person.id, type: "TRANSFER", state: "ASSIGNED", dueDate: new Date("2027-03-28"),
      titleTranslations: { en: "Assigned transfer", fr: "Transfert attribué", ar: "رحلة نقل مسندة" }, idempotencyKey: randomUUID(), createdBy: account.id } });
    const roles = await tx.role.findMany({ where: { key: { in: ["driver", "field_staff"] } } });
    let cashGrant = "";
    for (const key of ["driver", "field_staff"]) {
      const grant = await tx.roleAssignment.create({ data: { organizationId: org, personId: person.id, userAccountId: account.id,
        roleId: roles.find(role => role.key === key)!.id, scopeType: "job", scopeId: task.id,
        validFrom: new Date("2020-01-01"), conditions: { assignedToMe: true } } });
      if (key === "driver") cashGrant = grant.id;
    }
    return { org, person, account, property, task, cashGrant };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function actor(f: Fixture): Promise<ReservationActorContext> {
  return { organizationId: f.org, actorId: f.account.id, personId: f.person.id,
    authContext: { ...(await authContextForAccount(f.org, f.account.id, { db })), personId: f.person.id } };
}
async function snapshot(f: Fixture) {
  const result = await pullFieldWork(await actor(f), fieldPullInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, mode: "assigned", include_cash: true }), { db });
  return result.tasks.find(task => task.id === f.task.id)?.cash;
}
async function input(f: Fixture, overrides = {}, deviceId: string = randomUUID(), clientOpId: string = randomUUID()) {
  const cash = await snapshot(f); expect(cash?.canCollect).toBe(true);
  return syncPushInputSchema.parse({ organization_id: f.org, actor_user_id: f.account.id, device_id: deviceId, op_schema_version: 1,
    ops: [{ type: "field_cash.collect", client_op_id: clientOpId, client_created_at: "2099-03-29T00:30:00+14:00",
      payload: { taskId: f.task.id, amount: "500.25", currency: "MAD", payer: "Dedicated fictional guest", purpose: "Guest transfer cash", expectedRevision: cash!.revision, ...overrides } }] });
}
const push = async (f: Fixture, value: Awaited<ReturnType<typeof input>>, ctx?: ReservationActorContext) => pushSyncOps(ctx ?? await actor(f), value, { db, requestId: randomUUID() });
async function counts(f: Fixture) {
  return withTenant(db, f.org, async tx => ({ collections: await tx.cashCollection.count(), transactions: await tx.financialTransaction.count(),
    audits: await tx.auditLog.count({ where: { action: "cash_collection.recorded" } }), events: await tx.outboxEvent.count({ where: { type: "PaymentReceived" } }) }));
}

describe("native cash sync on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local PostgreSQL is required for cash integration");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it("atomically records exact custody, provenance, audit and one payment event without accruing revenue", async () => {
    const f = await fixture(), request = await input(f), result = await push(f, request);
    expect(result.results[0].status).toBe("APPLIED");
    expect(await counts(f)).toEqual({ collections: 1, transactions: 1, audits: 1, events: 1 });
    await withTenant(db, f.org, async tx => {
      const row = await tx.cashCollection.findFirstOrThrow({ include: { transaction: { include: { postings: { include: { ledgerAccount: true } } } } } });
      expect(row.amount.toFixed(2)).toBe("500.25"); expect(row.propertyId).toBe(f.property.id); expect(row.collectorPersonId).toBe(f.person.id);
      expect(row.clientCreatedAt?.toISOString()).toBe(new Date("2099-03-29T00:30:00+14:00").toISOString());
      expect(row.recordedAt.getUTCFullYear()).toBe(new Date().getUTCFullYear()); expect(row.transaction.occurredAt).toEqual(row.recordedAt);
      expect(row.transaction.postings.map(posting => ({ side: posting.side, amount: posting.amount.toFixed(2), currency: posting.currency, bucket: posting.bucket })).sort((a,b) => a.side.localeCompare(b.side))).toEqual([
        { side: "CREDIT", amount: "500.25", currency: "MAD", bucket: "UNALLOCATED_COLLECTION" },
        { side: "DEBIT", amount: "500.25", currency: "MAD", bucket: "CASH_COLLECTION" }
      ]);
      expect(row.transaction.postings.find(posting => posting.side === "CREDIT")!.ledgerAccount.code).toBe("UNALLOCATED_COLLECTIONS");
      expect(await tx.posting.count({ where: { bucket: { in: ["OWNER_REVENUE", "COMMISSION"] } } })).toBe(0);
    });
    expect((await snapshot(f))?.receipts[0]).toMatchObject({ amount: "500.25", currency: "MAD", payer: "Dedicated fictional guest" });
  });
  it("retains the reservation's original effective financial snapshot when newer agreement snapshots exist", async () => {
    const f = await fixture();
    const source = await withTenant(db, f.org, async tx => {
      const reservation = await tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: randomUUID(),
        source: "DIRECT", guestName: "Dedicated agreement guest", checkIn: new Date("2027-03-28"), checkOut: new Date("2027-03-30"), nights: 2, idempotencyKey: randomUUID() } });
      const rules = { owners: [{ ownerId: randomUUID(), agreementId: randomUUID(), agreementVersion: 3, commissionPercentage: "17.5" }] };
      const first = await tx.reservationFinancialSnapshot.create({ data: { organizationId: f.org, reservationId: reservation.id, version: 1, rules } });
      await tx.reservationFinancialSnapshot.create({ data: { organizationId: f.org, reservationId: reservation.id, version: 2,
        rules: { owners: [{ ...rules.owners[0], agreementVersion: 4, commissionPercentage: "21" }] } } });
      await tx.operationTask.update({ where: { id: f.task.id }, data: { reservationId: reservation.id } });
      return first;
    });
    expect((await push(f, await input(f))).results[0].status).toBe("APPLIED");
    const cash = await withTenant(db, f.org, tx => tx.cashCollection.findFirstOrThrow());
    expect(cash.provenance).toMatchObject({ reservationFinancialSnapshot: { id: source.id, version: 1, rules: source.rules } });
    expect(await withTenant(db, f.org, tx => tx.reservationFinancialSnapshot.findUniqueOrThrow({ where: { id: source.id } }))).toEqual(source);
    expect(await withTenant(db, f.org, tx => tx.posting.count({ where: { bucket: { in: ["OWNER_REVENUE", "COMMISSION"] } } }))).toBe(0);
  });
  it("confirms a duplicate device collection through an audited review without another journal or event", async () => {
    const f = await fixture(), first = await input(f), other = structuredClone(first);
    other.device_id = randomUUID(); other.ops[0].client_op_id = randomUUID();
    expect((await push(f, first)).results[0].status).toBe("APPLIED");
    expect((await push(f, other)).results[0].status).toBe("CONFLICT");
    const receipt = await withTenant(db, f.org, tx => tx.cashCollection.findFirstOrThrow());
    const confirmation = syncPushInputSchema.parse({ ...other, ops: [{ type: "field_cash.confirm_existing", client_op_id: randomUUID(),
      payload: { taskId: f.task.id, originalDeviceId: other.device_id, originalClientOpId: other.ops[0].client_op_id,
        receiptId: receipt.id, reason: "Reviewed both devices: the same guest cash" } }] });
    const wrong = syncPushInputSchema.parse({ ...confirmation, ops: [{ ...confirmation.ops[0], client_op_id: randomUUID(),
      payload: { ...confirmation.ops[0].payload, receiptId: randomUUID() } }] });
    expect((await push(f, wrong)).results[0].status).toBe("REJECTED");
    expect((await push(f, confirmation)).results[0].status).toBe("APPLIED");
    expect((await push(f, confirmation)).results[0].status).toBe("DUPLICATE");
    expect(await counts(f)).toEqual({ collections: 1, transactions: 1, audits: 1, events: 1 });
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { action: "cash_collection.duplicate_confirmed" } }))).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.syncOp.findFirstOrThrow({ where: { deviceId: other.device_id, clientOpId: other.ops[0].client_op_id } }))).toMatchObject({ status: "CONFLICT" });
  });
  it("serializes duplicate device requests into one receipt and preserves key-reuse rejection", async () => {
    const f = await fixture(), request = await input(f);
    const results = await Promise.all([push(f, request), push(f, request)]);
    expect(results.map(result => result.results[0].status).sort()).toEqual(["APPLIED", "DUPLICATE"]);
    const changed = structuredClone(request); if (changed.ops[0].type !== "field_cash.collect") throw new Error("Cash fixture expected");
    changed.ops[0].payload.amount = "501.00";
    expect((await push(f, changed)).results[0].error_code).toBe("REJECTED_IDEMPOTENCY_KEY_REUSED");
    expect(await counts(f)).toEqual({ collections: 1, transactions: 1, audits: 1, events: 1 });
  });
  it("requires explicit review for concurrent cross-device captures of the same observed position", async () => {
    const f = await fixture(), first = await input(f), second = structuredClone(first); second.device_id = randomUUID(); second.ops[0].client_op_id = randomUUID();
    const results = await Promise.all([push(f, first), push(f, second)]);
    expect(results.map(result => result.results[0].status).sort()).toEqual(["APPLIED", "CONFLICT"]);
    expect(results.flatMap(result => result.results).find(result => result.status === "CONFLICT")?.error_code).toBe("CASH_COLLECTION_CONFLICT");
    expect(await counts(f)).toEqual({ collections: 1, transactions: 1, audits: 1, events: 1 });
    expect(await withTenant(db, f.org, tx => tx.syncOp.count({ where: { status: "CONFLICT" } }))).toBe(1);
  });
  it("denies operational-only, foreign-tenant and forged collector access without financial writes", async () => {
    const f = await fixture(), foreign = await fixture(), request = await input(f);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.cashGrant }, data: { validTo: new Date("2021-01-01") } }));
    expect((await push(f, request)).results[0].status).toBe("REJECTED"); expect(await snapshot(f)).toBeUndefined();
    const forbidden = structuredClone(request); forbidden.device_id = randomUUID(); forbidden.ops[0].client_op_id = randomUUID(); forbidden.ops[0].payload.taskId = foreign.task.id;
    expect((await push(f, forbidden)).results[0].status).toBe("REJECTED");
    expect(syncPushInputSchema.safeParse({ ...request, ops: [{ ...request.ops[0], payload: { ...request.ops[0].payload, collectorPersonId: foreign.person.id } }] }).success).toBe(false);
    expect(await counts(f)).toEqual({ collections: 0, transactions: 0, audits: 0, events: 0 });
  });
  it("rechecks grant revocation after a real task-lock wait", async () => {
    const f = await fixture(), request = await input(f), cached = await actor(f);
    let release!: () => void, locked!: (pid: number) => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<number>(resolve => { locked = resolve; });
    const holder = withTenant(db, f.org, async tx => { await new OperationRepository(tx, f.org).lock(f.task.id);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; locked(row.pid); await hold; });
    const pid = await ready, pending = push(f, request, cached);
    try {
      await expect.poll(async () => { const [row] = await admin.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT count(*) AS count FROM pg_stat_activity WHERE ${pid}=ANY(pg_blocking_pids(pid))`); return Number(row.count); }, { timeout: 5000 }).toBeGreaterThan(0);
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.cashGrant }, data: { validTo: new Date("2021-01-01") } }));
    } finally { release(); await holder; }
    expect((await pending).results[0].error_code).toBe("REJECTED_FORBIDDEN");
    expect(await counts(f)).toEqual({ collections: 0, transactions: 0, audits: 0, events: 0 });
  });
  it("keeps currencies separate and rejects unsupported precision before posting", async () => {
    const f = await fixture(); expect((await push(f, await input(f, { amount: "75.25", currency: "EUR" }))).results[0].status).toBe("APPLIED");
    expect((await push(f, await input(f, { amount: "0.50", currency: "JPY" }))).results[0].error_code).toBe("CASH_CURRENCY_UNAVAILABLE");
    expect((await push(f, await input(f, { currency: "ZZZ" }))).results[0].error_code).toBe("CASH_CURRENCY_UNAVAILABLE");
    expect(await counts(f)).toEqual({ collections: 1, transactions: 1, audits: 1, events: 1 });
    expect(await withTenant(db, f.org, tx => tx.posting.findMany({ select: { currency: true } }))).toEqual([{ currency: "EUR" }, { currency: "EUR" }]);
  });
  it("masks audit money for operational viewers and requires financial export authority", async () => {
    const f = await fixture(); await push(f, await input(f));
    await withTenant(db, f.org, async tx => {
      const permissions = await tx.permission.findMany({ where: { key: { in: ["audit_log:view", "audit_log:export"] } }, select: { id: true } });
      const role = await tx.role.create({ data: { organizationId: f.org, key: `cash_audit_${randomUUID().replaceAll("-", "")}`,
        name: "Dedicated audit observer", rolePermissions: { create: permissions.map(permission => ({ organizationId: f.org, permissionId: permission.id })) } } });
      await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.person.id,
        scopeType: "organization", validFrom: new Date("2020-01-01") } });
    });
    const ctx = await actor(f);
    const { row, resource } = await withTenant(db, f.org, async tx => { const repo = new AuditRepository(tx, f.org), rows = await repo.list({ action: "cash_collection.recorded" }, 10);
      return { row: rows[0], resource: (await repo.cashResources([rows[0].resourceId!])).get(rows[0].resourceId!)! }; });
    expect(presentAuditHistoryRow(ctx, row, "view", resource).after).toMatchObject({ amount: "500.25" });
    expect(presentAuditHistoryRow(ctx, row, "export", resource).after).toBe(maskedValue);
    expect(presentAuditHistoryRow(ctx, row).after).toBe(maskedValue);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.cashGrant }, data: { validTo: new Date("2021-01-01") } }));
    expect(presentAuditHistoryRow(await actor(f), row, "view", resource).after).toBe(maskedValue);
  });
  it("enforces append-only receipts and forced tenant isolation without changing the original", async () => {
    const f = await fixture(), foreign = await fixture(); await push(f, await input(f));
    const original = await withTenant(db, f.org, tx => tx.cashCollection.findFirstOrThrow());
    await expect(withTenant(db, f.org, async tx => { await tx.cashCollection.update({ where: { id: original.id }, data: { amount: "1.00" } });
      throw new Error("Rollback if append-only guard is missing"); })).rejects.toThrow(/append only/u);
    expect(await withTenant(db, foreign.org, tx => tx.cashCollection.findMany({ where: { organizationId: f.org } }))).toEqual([]);
    expect(await withTenant(db, f.org, tx => tx.cashCollection.findUniqueOrThrow({ where: { id: original.id } }))).toEqual(original);
  });
});
