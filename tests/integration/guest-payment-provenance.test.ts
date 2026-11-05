import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { reviewGuestDepositReceipt, postGuestDepositReceipt } from "@/modules/finance/application/guest-deposit-service";
import { reviewGuestDepositCashAdmission, admitGuestDepositCash } from "@/modules/finance/application/guest-deposit-cash-service";
import * as provenanceService from "@/modules/finance/application/guest-payment-provenance-service";
import * as auditWriter from "@/platform/audit/audit-writer";
import { GuestDepositAuthorizationError } from "@/modules/finance/domain/guest-deposit";
import { readGuestDepositWorkspace } from "@/modules/finance/application/guest-deposit-workspace-service";
import { guestDepositDetailSchema } from "@/modules/finance/domain/guest-deposit-workspace";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { actualGuestDepositCashFixture } from "./support/guest-deposit-cash-fixture";
import { provisionIntegrationRole } from "./support/database-role";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient, control: PrismaClient;
let legacy: Awaited<ReturnType<typeof actualGuestDepositFixture>>, legacyId: string, legacyDepositId: string, beforeUpgrade: Awaited<ReturnType<typeof facts>>;
function facts(org: string) { return withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid
  UNION ALL SELECT 'audit',id::text,xmin::text,to_jsonb(a)::text FROM audit_log a WHERE organization_id=${org}::uuid AND resource_type='financial_transaction' ORDER BY kind,id`); }
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned provenance acceptance database required");
  control = new PrismaClient({ datasourceUrl: url });
  const database = "alvillas_automation_provenance169_" + randomUUID().replaceAll("-", "").slice(0, 20);
  if (!/^[a-z0-9_]{1,63}$/u.test(database)) throw Error("Owned shadow identifier required");
  await control.$executeRawUnsafe('CREATE DATABASE "' + database + '"');
  const shadow = new URL(url!); shadow.pathname = "/" + database;
  const directory = resolve(".tmp/provenance-upgrade-" + database), migrationRoot = resolve("prisma/migrations"), migrations = readdirSync(migrationRoot, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort(), previous = migrations.filter(name => name < "20261105051500_guest_payment_provenance");
  if (previous.length !== 168) throw Error("Preserve the complete original migration chain");
  mkdirSync(directory + "/migrations", { recursive: true }); copyFileSync("prisma/schema.prisma", directory + "/schema.prisma"); copyFileSync(migrationRoot + "/migration_lock.toml", directory + "/migrations/migration_lock.toml");
  for (const name of previous) { mkdirSync(directory + "/migrations/" + name); copyFileSync(migrationRoot + "/" + name + "/migration.sql", directory + "/migrations/" + name + "/migration.sql"); }
  const migrate = (schema: string) => execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", schema], { env: { ...process.env, DATABASE_URL: shadow.toString() }, stdio: "pipe" });
  migrate(directory + "/schema.prisma");
  admin = new PrismaClient({ datasourceUrl: shadow.toString() }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(shadow); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  for (const code of ["MAD", "EUR"]) await admin.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
  // Only the pre-upgrade fixture emulates the former producer; the new native guard is not installed yet.
  const former = vi.spyOn(provenanceService, "retainGuestPaymentProvenance").mockResolvedValue(undefined);
  try {
    legacy = await actualGuestDepositFixture(db, admin); const review = await reviewGuestDepositReceipt(legacy.ctx, legacy.receiptInput, { db });
    legacyDepositId = randomUUID();
    legacyId = (await postGuestDepositReceipt(legacy.ctx, { ...legacy.receiptInput, reviewFingerprint: review.reviewFingerprint, idempotencyKey: legacyDepositId, reason: "Original receipt committed before provenance migration" }, { db })).id;
    beforeUpgrade = await facts(legacy.org);
  } finally { former.mockRestore(); }
  migrate(resolve("prisma/schema.prisma")); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  expect(await facts(legacy.org)).toEqual(beforeUpgrade);
}, 120000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); await control?.$disconnect(); });
const retained = (org: string) => withTenant(db, org, tx => tx.guestPaymentReceipt.findMany({ where: { organizationId: org }, include: { owners: { orderBy: { ordinal: "asc" } } } }));
async function command(f: Awaited<ReturnType<typeof actualGuestDepositFixture>>) {
  const review = await reviewGuestDepositReceipt(f.ctx, f.receiptInput, { db });
  return { ...f.receiptInput, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Retain exact original guest payment provenance atomically" };
}
async function personalAuthority(f: Awaited<ReturnType<typeof actualGuestDepositFixture>>) {
  const grant = await withTenant(db, f.org, async tx => {
    const role = await tx.role.create({ data: { organizationId: f.org, key: "receipt_personal_context_" + randomUUID(), name: "Independent receipt personal-name authority" } });
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["owner:view", "team_member:view", "guest:view"] } } });
    expect(permissions).toHaveLength(3);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
    return tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: f.account.id, personId: f.person.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
  });
  return { grant, ctx: { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } } };
}
async function detail(ctx: Parameters<typeof readGuestDepositWorkspace>[0], depositId: string) {
  return guestDepositDetailSchema.parse(await readGuestDepositWorkspace(ctx, { operation: "DETAIL", depositId }, { db }));
}
describe("durable original guest receipt provenance", () => {
  it("upgrades populated financial history without rewriting bodies, tuple versions or historical provenance", async () => {
    expect(await facts(legacy.org)).toEqual(beforeUpgrade); expect(await retained(legacy.org)).toEqual([]);
    await expect(withTenant(db, legacy.org, tx => provenanceService.retainGuestPaymentProvenance(legacy.ctx, tx, legacyId))).rejects.toThrow("original new sealed receipt");
    expect(await retained(legacy.org)).toEqual([]); expect(await facts(legacy.org)).toEqual(beforeUpgrade);
  });
  it.each(["0.07", "9007199254740993.07"])("retains exact %s MAD and actual original owner, collector, account and booking witnesses", async amount => {
    const f = await actualGuestDepositFixture(db, admin, "MAD", 2, amount), input = await command(f), original = await facts(f.org), posted = await postGuestDepositReceipt(f.ctx, input, { db }), rows = await retained(f.org);
    expect(rows).toHaveLength(1); const row = rows[0];
    expect(row.transactionId).toBe(posted.id); expect(row.amount.toFixed(2)).toBe(amount); expect(row.accountId).toBe(f.banks.receipt.id); expect(row.collectorUserAccountId).toBe(f.account.id);
    const actual = await withTenant(db, f.org, async tx => ({ booking: await tx.reservation.findFirstOrThrow({ where: { organizationId: f.org, id: f.reservationId }, select: { guestId: true } }),
      snapshot: await tx.reservationFinancialSnapshot.findFirstOrThrow({ where: { organizationId: f.org, id: row.financialSnapshotId }, select: { rules: true } }) }));
    expect(row.provenance).toMatchObject({ amount: { amount, currency: "MAD" }, booking: { reservationId: f.reservationId, propertyId: f.property.id }, claim: { guestId: actual.booking.guestId } });
    expect(row.owners.map(owner => owner.ownerId)).toEqual((actual.snapshot.rules as { owners: { ownerId: string }[] }).owners.map(owner => owner.ownerId));
    const saved = await facts(f.org); expect(await postGuestDepositReceipt(f.ctx, input, { db })).toEqual({ ...posted, idempotent: true });
    expect(await facts(f.org)).toEqual(saved); expect(await retained(f.org)).toEqual(rows);
    const ids = new Set(original.map(value => value.kind + value.id)); expect(saved.filter(value => ids.has(value.kind + value.id))).toEqual(original);
  });
  it("retains original partial cash custody and collector while recording only the admitted guest claim", async () => {
    const f = await actualGuestDepositCashFixture(db, admin), draft = { collectionId: f.cash.id, reservationId: f.reservationId, kind: "stay", amount: "0.04", currency: "MAD", purpose: "Original partially admitted collected guest funds" }, review = await reviewGuestDepositCashAdmission(f.ctx, draft, { db }), original = await facts(f.org);
    await admitGuestDepositCash(f.ctx, { ...draft, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Retain original partial cash source without another custody movement" }, { db });
    const collected = await withTenant(db, f.org, tx => tx.cashCollection.findFirstOrThrow({ where: { organizationId: f.org, id: f.cash.id } }));
    const rows = await retained(f.org); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ originalCollectionId: f.cash.id, accountId: collected.custodyAccountId, collectorUserAccountId: collected.collectorUserAccountId, collectorPersonId: collected.collectorPersonId });
    expect(rows[0].amount.toFixed(2)).toBe("0.04"); const ids = new Set(original.map(value => value.kind + value.id)); expect((await facts(f.org)).filter(value => ids.has(value.kind + value.id))).toEqual(original);
  });
  it("requires provenance at the native boundary even when the application retention hook is bypassed", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f), original = await facts(f.org);
    vi.spyOn(provenanceService, "retainGuestPaymentProvenance").mockResolvedValue(undefined);
    await expect(postGuestDepositReceipt(f.ctx, input, { db })).rejects.toThrow("complete original guest payment provenance required");
    expect(await retained(f.org)).toEqual([]); expect(await facts(f.org)).toEqual(original);
  });
  it("isolates retained receipt and owner rows across tenants and refuses foreign parent links", async () => {
    const f = await actualGuestDepositFixture(db, admin), other = await actualGuestDepositFixture(db, admin), input = await command(f);
    await postGuestDepositReceipt(f.ctx, input, { db }); const rows = await retained(f.org), original = await facts(f.org);
    expect(await admin.$queryRaw`SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='guest_payment_receipt_owner' ORDER BY policyname`).toEqual([{ policyname: "guest_payment_receipt_owner_tenant_isolation" }]);
    await withTenant(db, other.org, async tx => {
      expect(await tx.guestPaymentReceipt.findMany({ where: { organizationId: f.org } })).toEqual([]);
      expect(await tx.guestPaymentReceiptOwner.findMany({ where: { organizationId: f.org } })).toEqual([]);
    });
    await expect(withTenant(db, other.org, tx => tx.guestPaymentReceiptOwner.create({ data: { organizationId: other.org, receiptId: rows[0].id, ownerId: rows[0].owners[0].ownerId, shareBps: 10000, ordinal: 0 } }))).rejects.toThrow();
    expect(await facts(f.org)).toEqual(original); expect(await retained(f.org)).toEqual(rows);
  });
  it("keeps every retained receipt and owner witness append-only", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f);
    await postGuestDepositReceipt(f.ctx, input, { db }); const rows = await retained(f.org), original = await facts(f.org), row = rows[0];
    await expect(withTenant(db, f.org, tx => tx.guestPaymentReceipt.update({ where: { id: row.id }, data: { amount: "0.08" } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.guestPaymentReceipt.delete({ where: { id: row.id } }))).rejects.toThrow();
    const where = { organizationId_receiptId_ownerId: { organizationId: f.org, receiptId: row.id, ownerId: row.owners[0].ownerId } };
    await expect(withTenant(db, f.org, tx => tx.guestPaymentReceiptOwner.update({ where, data: { shareBps: 5000 } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.guestPaymentReceiptOwner.delete({ where }))).rejects.toThrow();
    expect(await facts(f.org)).toEqual(original); expect(await retained(f.org)).toEqual(rows);
  });
  it("rolls the new receipt and every witness back when the attributed provenance audit fails", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation((tx, event) => { if (event.action === "finance.guest_payment.provenance_retained") throw Error("Retained provenance audit unavailable"); return write(tx, event); });
    await expect(postGuestDepositReceipt(f.ctx, input, { db })).rejects.toThrow("Retained provenance audit unavailable");
    expect(await retained(f.org)).toEqual([]); expect(await facts(f.org)).toEqual(original);
  });
  it("rechecks current finance authority after provenance is retained and rolls the entire admission back", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.guest_payment.provenance_retained") await withTenant(db, f.org, inner => inner.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } })); return saved; });
    await expect(postGuestDepositReceipt(f.ctx, input, { db })).rejects.toThrow(GuestDepositAuthorizationError);
    expect(await retained(f.org)).toEqual([]); expect(await facts(f.org)).toEqual(original);
  });
  it("shows retained financial context while withholding independently protected personal names and identifiers", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f);
    await postGuestDepositReceipt(f.ctx, input, { db });
    const read = await detail(f.ctx, input.idempotencyKey);
    expect(read.provenance).toEqual({ organizationName: "Actual service collection source", collectorName: null, recordedByName: null, accountName: f.banks.receipt.name, owners: [{ name: null }], bookingSource: "DIRECT", receivedAt: input.receivedAt });
    expect(read.summary.guestName).toBeNull();
    const privateNames = JSON.stringify(read.provenance);
    expect(privateNames).not.toContain(f.person.id); expect(privateNames).not.toContain(f.account.id);
    expect(privateNames).not.toContain(f.person.displayName); expect(privateNames).not.toContain("Actual confirmed booking owner");
  });
  it("uses frozen owner names and both held and current independent personal grants", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f);
    await postGuestDepositReceipt(f.ctx, input, { db }); const authority = await personalAuthority(f), rows = await retained(f.org);
    await withTenant(db, f.org, tx => tx.owner.update({ where: { id: rows[0].owners[0].ownerId }, data: { displayName: "Renamed owner after original receipt" } }));
    expect((await detail(f.ctx, input.idempotencyKey)).provenance?.owners).toEqual([{ name: null }]);
    const read = await detail(authority.ctx, input.idempotencyKey);
    expect(read.provenance?.owners).toEqual([{ name: "Actual confirmed booking owner" }]);
    expect(read.provenance?.collectorName).toBe(f.person.displayName); expect(read.provenance?.recordedByName).toBe(f.person.displayName);
    expect(read.summary.guestName).toBe("Actual original deposit guest");
    expect(JSON.stringify(read.provenance)).not.toContain("Renamed owner after original receipt");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: authority.grant.id }, data: { archivedAt: new Date() } }));
    expect((await detail(authority.ctx, input.idempotencyKey)).provenance?.collectorName).toBeNull();
  });
  it("withholds the complete disclosure when personal authority is revoked after its read audit", async () => {
    const f = await actualGuestDepositFixture(db, admin), input = await command(f);
    await postGuestDepositReceipt(f.ctx, input, { db }); const authority = await personalAuthority(f), original = await facts(f.org), write = auditWriter.writeAuditEvent;
    vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { const saved = await write(tx, event); if (event.action === "finance.guest_deposit.detail_viewed") await withTenant(db, f.org, inner => inner.roleAssignment.update({ where: { id: authority.grant.id }, data: { archivedAt: new Date() } })); return saved; });
    await expect(detail(authority.ctx, input.idempotencyKey)).rejects.toThrow(GuestDepositAuthorizationError);
    expect(await facts(f.org)).toEqual(original);
  });
  it("retains original cash funding authority for a smaller admitted claim", async () => {
    const f = await actualGuestDepositCashFixture(db, admin), draft = { collectionId: f.cash.id, reservationId: f.reservationId, kind: "stay", amount: "0.04", currency: "MAD", purpose: "Source-authorized partial original collection context" }, review = await reviewGuestDepositCashAdmission(f.ctx, draft, { db }), key = randomUUID();
    await admitGuestDepositCash(f.ctx, { ...draft, reviewFingerprint: review.reviewFingerprint, idempotencyKey: key, reason: "Keep the complete original cash source private" }, { db });
    const cash = await withTenant(db, f.org, tx => tx.cashCollection.findFirstOrThrow({ where: { organizationId: f.org, id: f.cash.id }, include: { custodyAccount: true } }));
    expect((await detail(f.ctx, key)).provenance).toMatchObject({ accountName: cash.custodyAccount.name, receivedAt: cash.recordedAt.toISOString() });
    const capped = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: f.ctx.authContext.assignments?.map(assignment => ({ ...assignment, conditions: { ...assignment.conditions, maxAmount: "0.04" } })) } };
    await expect(detail(capped, key)).rejects.toThrow(GuestDepositAuthorizationError);
  });
  it("reads historical receipts with explicit unavailable context and no retroactive attribution", async () => {
    const read = await detail(legacy.ctx, legacyDepositId);
    expect(read.summary.transactionId).toBe(legacyId); expect(read.provenance).toBeNull(); expect(await retained(legacy.org)).toEqual([]);
  });
  it("refuses receipt context from another tenant", async () => {
    const f = await actualGuestDepositFixture(db, admin), other = await actualGuestDepositFixture(db, admin), input = await command(f);
    await postGuestDepositReceipt(f.ctx, input, { db });
    await expect(detail(other.ctx, input.idempotencyKey)).rejects.toThrow();
  });
});
