import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { encryptSecret } from "@/platform/auth/secret-encryption";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { createOwnerPayout, getOwnerPayout, OwnerPayoutAccessError, OwnerPayoutConflictError } from "@/modules/finance/application/owner-payout-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;

async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Dedicated native payout acceptance", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const source = await withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated payout operator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const owner = await tx.owner.create({ data: { organizationId: org, displayName: "Dedicated payout beneficiary" } });
    const otherOwner = await tx.owner.create({ data: { organizationId: org, displayName: "Unrelated private payout owner" } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Dedicated payout villa", addressLine1: "Local acceptance", city: "Marrakech",
      propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    await tx.propertyOwner.create({ data: { organizationId: org, propertyId: property.id, ownerId: owner.id } });
    const bank = await new FinanceRepository(tx, org).ensureLedgerAccount({ code: "PAYOUT_QA_BANK", name: "Private company funding bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    const encrypted = encryptSecret("Dedicated local nonproduction bank reference");
    const method = await tx.ownerPayoutMethod.create({ data: { organizationId: org, ownerId: owner.id, label: "Dedicated beneficiary method", methodType: "BANK_TRANSFER",
      accountHolderName: "Dedicated payout beneficiary", currency: "MAD", countryCode: "MA", detailsEncrypted: encrypted, maskedAccount: "****7890" } });
    const role = await tx.role.create({ data: { organizationId: org, key: `payout_qa_${randomUUID()}`, name: "Scoped payout acceptance" } });
    const permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: ["financial_transaction:view", "financial_transaction:create"] } } });
    expect(permissions).toHaveLength(2);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const ownerGrant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, personId: person.id, userAccountId: account.id, scopeType: "owner", scopeId: owner.id, validFrom: new Date("2020-01-01") } });
    const bankGrant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, personId: person.id, userAccountId: account.id, scopeType: "financial_record", scopeId: bank.id, validFrom: new Date("2020-01-01") } });
    return { account, owner, otherOwner, property, bank, method, encrypted, ownerGrant, bankGrant };
  });
  const ctx = { organizationId: org, actorId: source.account.id, authContext: await authContextForAccount(org, source.account.id, { db }) };
  const input = { propertyId: source.property.id, ownerId: source.owner.id, payoutMethodId: source.method.id, fundingAccountId: source.bank.id,
    amount: "9999999999999999.99", currency: "MAD", purpose: "Dedicated owner payout draft", reason: "Dedicated payout persistence acceptance", idempotencyKey: randomUUID() };
  return { ...source, org, ctx, input };
}

describe("native owner payout persistence on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url });await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url);scoped.username = "alvillas_ops_tests";scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect();await admin?.$disconnect(); });

  it("stores exact draft cents and attributed reads without creating a payment or disclosing bank secrets", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    const view = await getOwnerPayout(f.ctx, created.id, { db });
    expect(view).toMatchObject({ amount: f.input.amount, currency: "MAD", state: "DRAFT", version: 1, paidAt: null });
    expect(JSON.stringify(view)).not.toContain(f.encrypted);expect(JSON.stringify(view)).not.toContain("Dedicated local nonproduction bank reference");
    expect(JSON.stringify(view)).not.toContain(f.bank.id);expect(JSON.stringify(view)).not.toContain(f.bank.name);
    await withTenant(db, f.org, async tx => {
      expect(await tx.financialTransaction.count()).toBe(0);expect(await tx.posting.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { resourceId: created.id, action: "finance.owner_payout.created", actorId: f.account.id } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: created.id, action: "finance.owner_payout.viewed", actorId: f.account.id } })).toBe(1);
    });
  });

  it("serializes duplicate creation identities and rejects a conflicting request without duplicate business rows", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => createOwnerPayout(f.ctx, { ...f.input, idempotencyKey: index % 2 ? f.input.idempotencyKey.toUpperCase() : f.input.idempotencyKey }, { db })));
    expect(new Set(results.map(row => row.id)).size).toBe(1);expect(results.filter(row => !row.idempotent)).toHaveLength(1);
    await expect(createOwnerPayout(f.ctx, { ...f.input, purpose: "Conflicting payout intent" }, { db })).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    await withTenant(db, f.org, async tx => { expect(await tx.ownerPayout.count()).toBe(1);expect(await tx.auditLog.count({ where: { action: "finance.owner_payout.created" } })).toBe(1); });
  });

  it("requires both current and caller authority and rejects another owner's scope before creation", async () => {
    const f = await fixture();
    await expect(createOwnerPayout({ ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(), assignments: [] } }, f.input, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await expect(createOwnerPayout(f.ctx, { ...f.input, ownerId: f.otherOwner.id }, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.ownerGrant.id }, data: { validTo: new Date("2021-01-01") } }));
    await expect(createOwnerPayout(f.ctx, f.input, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect(await withTenant(db, f.org, tx => tx.ownerPayout.count())).toBe(0);
  });

  it("keeps funding permission independent while allowing the beneficiary-scoped payout summary", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.bankGrant.id }, data: { validTo: new Date("2021-01-01") } }));
    await expect(createOwnerPayout(f.ctx, { ...f.input, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect((await getOwnerPayout(f.ctx, created.id, { db })).amount).toBe(f.input.amount);
  });

  it("enforces tenant isolation in both the application and PostgreSQL RLS", async () => {
    const a = await fixture(), b = await fixture(), created = await createOwnerPayout(b.ctx, b.input, { db });
    await expect(getOwnerPayout(a.ctx, created.id, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect(await withTenant(db, a.org, tx => tx.ownerPayout.findMany({ where: { id: created.id } }))).toEqual([]);
    await expect(createOwnerPayout(a.ctx, { ...a.input, propertyId: b.property.id }, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
  });

  it("rejects skipped approval, unaudited rewrites and business deletion without changing the original row version", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    const original = await withTenant(db, f.org, tx => tx.$queryRaw<Array<{ version: string }>>(Prisma.sql`SELECT xmin::text AS version FROM owner_payout WHERE id=${created.id}::uuid`));
    await expect(withTenant(db, f.org, tx => tx.ownerPayout.update({ where: { id: created.id }, data: { state: "PAID", version: 2 } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.ownerPayout.update({ where: { id: created.id }, data: { purpose: "Unaudited attempted rewrite", version: 2 } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.ownerPayout.delete({ where: { id: created.id } }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.$queryRaw(Prisma.sql`SELECT xmin::text AS version FROM owner_payout WHERE id=${created.id}::uuid`))).toEqual(original);
    expect((await getOwnerPayout(f.ctx, created.id, { db })).purpose).toBe(f.input.purpose);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
});
