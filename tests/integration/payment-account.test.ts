import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient,type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createPaymentAccount, listPaymentAccounts, PaymentAccountAccessError, PaymentAccountConflictError } from "@/modules/finance/application/payment-account-service";
import { paymentAccountCode } from "@/modules/finance/domain/payment-account";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture(options: { scope?: "organization" | "property"; cap?: string; permissions?: string[] } = {}) {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Dedicated local payment account", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const saved = await withTenant(db, org, async tx => {
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated account configurator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const role = await tx.role.create({ data: { organizationId: org, key: "payment_account_fixture", name: "Dedicated financial access" } });
    const keys = options.permissions ?? ["financial_transaction:view", "financial_transaction:configure"];
    const permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: keys } } });
    expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, userAccountId: account.id, personId: person.id,
      roleId: role.id, scopeType: options.scope ?? "organization", scopeId: options.scope === "property" ? randomUUID() : null,
      validFrom: new Date("2020-01-01"), ...(options.cap ? { conditions: { maxAmount: options.cap } } : {}) } });
    return { account, grant };
  });
  const actor = { organizationId: org, actorId: saved.account.id, authContext: await authContextForAccount(org, saved.account.id, { db }) };
  const input = { name: "Dedicated company bank", kind: "BANK" as const, idempotencyKey: randomUUID(), reason: "Dedicated local funding account" };
  return { org, ...saved, actor, input };
}

describe("native payment accounts on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient<Prisma.PrismaClientOptions>({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    db = new PrismaClient<Prisma.PrismaClientOptions>({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

  it("creates one audited location across concurrent original-key retries without posting money", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => createPaymentAccount(f.actor,
      { ...f.input, idempotencyKey: index === 0 ? f.input.idempotencyKey.toUpperCase() : f.input.idempotencyKey }, { db })));
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    const state = await withTenant(db, f.org, async tx => ({ accounts: await tx.ledgerAccount.findMany(), audits: await tx.auditLog.findMany(),
      journals: await tx.financialTransaction.count(), postings: await tx.posting.count() }));
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({ code: paymentAccountCode(f.input), name: f.input.name, accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ actorId: f.account.id, resourceType: "ledger_account", action: "finance.account.created", reason: f.input.reason,
      after: { kind: "BANK", accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
    expect(state.journals).toBe(0); expect(state.postings).toBe(0);
  });

  it("rejects changed facts, kind or actor on a reserved request key", async () => {
    const f = await fixture(), first = await createPaymentAccount(f.actor, f.input, { db });
    for (const change of [{ name: "Changed account" }, { reason: "Changed account reason" }, { kind: "CASH" }])
      await expect(createPaymentAccount(f.actor, { ...f.input, ...change }, { db })).rejects.toBeInstanceOf(PaymentAccountConflictError);
    const otherActor = await withTenant(db, f.org, async tx => {
      const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Other dedicated configurator" } });
      const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } });
      await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: f.grant.roleId,
        scopeType: "organization", validFrom: new Date("2020-01-01") } });
      return account;
    });
    const actor = { organizationId: f.org, actorId: otherActor.id, authContext: await authContextForAccount(f.org, otherActor.id, { db }) };
    await expect(createPaymentAccount(actor, f.input, { db })).rejects.toBeInstanceOf(PaymentAccountConflictError);
    expect((await listPaymentAccounts(f.actor, {}, { db })).accounts.map(row => row.id)).toEqual([first.id]);
  });

  it("requires independent global financial view/configure and denies scoped or amount-capped access", async () => {
    for (const options of [{ permissions: ["financial_transaction:view"] }, { permissions: ["financial_transaction:configure"] },
      { permissions: ["task:edit", "task:view"] }, { scope: "property" as const }, { cap: "9000" }]) {
      const f = await fixture(options);
      await expect(createPaymentAccount(f.actor, f.input, { db })).rejects.toBeInstanceOf(PaymentAccountAccessError);
      if (options.permissions?.includes("financial_transaction:view")) expect((await listPaymentAccounts(f.actor, {}, { db })).canConfigure).toBe(false);
      else await expect(listPaymentAccounts(f.actor, {}, { db })).rejects.toBeInstanceOf(PaymentAccountAccessError);
      expect(await withTenant(db, f.org, tx => tx.ledgerAccount.count())).toBe(0);
    }
  });

  it("reloads stored grants rather than accepting a previously authorized context", async () => {
    const f = await fixture();
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: new Date("2025-01-01") } }));
    await expect(createPaymentAccount(f.actor, f.input, { db })).rejects.toBeInstanceOf(PaymentAccountAccessError);
    await expect(listPaymentAccounts(f.actor, {}, { db })).rejects.toBeInstanceOf(PaymentAccountAccessError);
  });

  it("preserves ownership accounts and pages the actual chart without crossing tenants", async () => {
    const f = await fixture(), other = await fixture();
    const claim = await withTenant(db, f.org, tx => tx.ledgerAccount.create({ data: { organizationId: f.org, code: "OWNER_PAYABLE", name: "Owner ownership claim",
      accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" } }));
    await createPaymentAccount(f.actor, f.input, { db });
    await withTenant(db, f.org, tx => tx.ledgerAccount.createMany({ data: Array.from({ length: 51 }, (_, index) => ({ organizationId: f.org,
      code: `DEDICATED_CHART_${index}`, name: `Dedicated chart row ${index}`, accountType: "ASSET_LOCATION", normalSide: "DEBIT" })) }));
    const first = await listPaymentAccounts(f.actor, {}, { db }); expect(first.accounts).toHaveLength(50); expect(first.next).toBeTruthy();
    const second = await listPaymentAccounts(f.actor, { after: first.next }, { db }); expect(second.accounts).toHaveLength(3); expect(second.next).toBeUndefined();
    expect(new Set([...first.accounts, ...second.accounts].map(row => row.id)).size).toBe(53);
    expect([...first.accounts, ...second.accounts].find(row => row.id === claim.id)).toMatchObject({ accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    expect((await listPaymentAccounts(other.actor, {}, { db })).accounts).toHaveLength(0);
    const forged = { ...other.actor, organizationId: f.org };
    await expect(createPaymentAccount(forged, f.input, { db })).rejects.toBeInstanceOf(PaymentAccountAccessError);
    expect((await listPaymentAccounts(f.actor, { query: f.input.name }, { db })).accounts).toHaveLength(1);
  });
});
