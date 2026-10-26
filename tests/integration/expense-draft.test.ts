import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createExpenseDraft, updateExpenseDraft, ExpenseAccessError, ExpenseConflictError } from "@/modules/finance/application/expense-service";
import { ExpenseRepository } from "@/modules/finance/infrastructure/expense-repository";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import { AuditRepository } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { evaluateExpensePolicy } from "@/modules/finance/application/finance-config-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated native expense integration", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated expense operator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Dedicated expense villa", addressLine1: "Local integration",
      city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const bank = await tx.ledgerAccount.create({ data: { organizationId: org, code: "DEDICATED_EXPENSE_BANK", name: "Dedicated local bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
    const role = await tx.role.create({ data: { organizationId: org, key: "expense_operator", name: "Dedicated expense author" } });
    const auditRole = await tx.role.create({ data: { organizationId: org, key: "expense_auditor", name: "Independent audit access" } });
    for (const [subject, keys] of [[role, ["expense:create", "expense:view", "expense:edit", "financial_transaction:view"]], [auditRole, ["audit_log:view", "audit_log:export"]]] as const) {
      const permissions = await tx.permission.findMany({ where: { key: { in: [...keys] } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: subject.id, permissionId: permission.id })) });
    }
    const grant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, userAccountId: account.id, personId: person.id,
      scopeType: "property", scopeId: property.id, validFrom: new Date("2020-01-01") } });
    await tx.roleAssignment.create({ data: { organizationId: org, roleId: auditRole.id, userAccountId: account.id, personId: person.id,
      scopeType: "organization", validFrom: new Date("2020-01-01") } });
    const input = { propertyId: property.id, amount: "500.25", currency: "MAD", category: "maintenance", purpose: "Dedicated fictional repair",
      occurredOn: "2026-10-26", fundingAccountId: bank.id, emergency: false, idempotencyKey: randomUUID(), reason: "Dedicated native expense draft" };
    return { org, account, person, property, bank, grant, input };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function actor(f: Fixture) { return { organizationId: f.org, actorId: f.account.id,
  authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } }; }
const create = async (f: Fixture, input = f.input) => createExpenseDraft(await actor(f), input, { db });

describe("native expense drafts on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it("creates an audited unposted draft once across concurrent original-key retries", async () => {
    const f = await fixture(), results = await Promise.all([create(f), create(f)]);
    expect(results.map(result => result.idempotent).sort()).toEqual([false,true]); expect(results[0].id).toBe(results[1].id);
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.count()).toBe(1); expect(await tx.auditLog.count({ where: { action: "expense.created" } })).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.outboxEvent.count({ where: { type: "ExpenseSubmitted" } })).toBe(0);
      expect(await tx.expense.findFirstOrThrow()).toMatchObject({ state: "DRAFT", version: 1, transactionId: null });
    });
    await expect(create(f, { ...f.input, amount: "600" })).rejects.toBeInstanceOf(ExpenseConflictError);
  });
  it("retains one winning version and both audit facts when edits compete", async () => {
    const f = await fixture(), row = await create(f), ctx = await actor(f);
    const edits = await Promise.allSettled(["25.00","75.25"].map(amount => updateExpenseDraft(ctx, { id: row.id, expectedVersion: 1, draft: { ...f.input, amount } }, { db })));
    expect(edits.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const rejected = edits.find(value => value.status === "rejected"); expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toBeInstanceOf(ExpenseConflictError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.findFirstOrThrow()).toMatchObject({ version: 2 });
      const edit = await tx.auditLog.findFirstOrThrow({ where: { action: "expense.updated" } });
      expect(edit.before).toMatchObject({ amount: "500.25", version: 1 }); expect(edit.after).toMatchObject({ version: 2 });
    });
  });
  it("denies expired financial grants and foreign property/account references without creating drafts", async () => {
    const f = await fixture(), other = await fixture();
    await expect(create(f, { ...f.input, propertyId: other.property.id })).rejects.toBeInstanceOf(ExpenseAccessError);
    await expect(create(f, { ...f.input, fundingAccountId: other.bank.id })).rejects.toThrow();
    const stale = await actor(f); await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: new Date() } }));
    await expect(createExpenseDraft(stale, f.input, { db })).rejects.toBeInstanceOf(ExpenseAccessError);
    expect(await withTenant(db, f.org, tx => tx.expense.count())).toBe(0);
  });
  it("clears an optional reservation link while preserving its prior value in the audit", async () => {
    const f = await fixture();
    const reservation = await withTenant(db, f.org, tx => tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id,
      reference: randomUUID(), source: "DIRECT", guestName: "Dedicated fictional expense guest", checkIn: new Date("2027-04-01"), checkOut: new Date("2027-04-03"), nights: 2, idempotencyKey: randomUUID() } }));
    const row = await createExpenseDraft(await actor(f), { ...f.input, reservationId: reservation.id }, { db });
    await updateExpenseDraft(await actor(f), { id: row.id, expectedVersion: 1, draft: f.input }, { db });
    await withTenant(db, f.org, async tx => {
      expect((await tx.expense.findUniqueOrThrow({ where: { id: row.id } })).reservationId).toBeNull();
      expect((await tx.auditLog.findFirstOrThrow({ where: { action: "expense.updated" } })).before).toMatchObject({ reservationId: reservation.id });
    });
  });
  it("masks historical large amounts when a later smaller draft falls inside the current grant", async () => {
    const f = await fixture(), row = await create(f);
    await updateExpenseDraft(await actor(f), { id: row.id, expectedVersion: 1, draft: { ...f.input, amount: "25" } }, { db });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { conditions: { maxAmount: "100" } } }));
    const ctx = { ...await actor(f), personId: f.person.id };
    await withTenant(db, f.org, async tx => {
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: "expense.updated" } });
      const resource = (await new AuditRepository(tx, f.org).expenseResources([row.id])).get(row.id)!;
      expect(resource.amount).toBe("25"); expect(presentAuditHistoryRow(ctx, audit, "view", resource).before).toBe(maskedValue);
      const created = await tx.auditLog.findFirstOrThrow({ where: { action: "expense.created" } });
      expect(presentAuditHistoryRow(ctx, created, "export", resource).after).toBe(maskedValue);
    });
  });
  it("keeps submitted facts and submission snapshots immutable under tenant RLS", async () => {
    const f = await fixture(), other = await fixture(), row = await create(f);
    await withTenant(db, f.org, async tx => {
      const repository = new ExpenseRepository(tx, f.org); await repository.transition(row.id, 1, "DRAFT", "PENDING_APPROVAL", f.account.id);
      await repository.submit(row.id, f.account.id, { fixture: "Immutable-source storage guard only; native submission acceptance remains pending" }, new Date());
    });
    await expect(withTenant(db, f.org, tx => tx.expense.update({ where: { id: row.id }, data: { amount: "1", version: { increment: 1 } } }))).rejects.toThrow("immutable");
    await expect(withTenant(db, f.org, tx => tx.expenseSubmission.updateMany({ data: { snapshot: {} } }))).rejects.toThrow("append-only");
    expect(await withTenant(db, other.org, tx => tx.expense.findMany({ where: { id: row.id } }))).toEqual([]);
    expect(await withTenant(db, f.org, tx => tx.expense.findUniqueOrThrow({ where: { id: row.id } }))).toMatchObject({ state: "PENDING_APPROVAL", version: 2 });
  });
  it("resolves agreement scope and versioned condition references through the existing policy consumer", async () => {
    const f = await fixture();
    const source = await withTenant(db, f.org, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "expense_policy_configurer", name: "Dedicated policy configuration" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["financial_transaction:configure", "financial_transaction:view"] } } });
      expect(permissions).toHaveLength(2);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
      await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: f.account.id, personId: f.person.id, roleId: role.id,
        scopeType: "organization", validFrom: new Date("2020-01-01") } });
      const agreement = await tx.managementAgreement.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: "Dedicated expense agreement",
        effectiveFrom: new Date("2026-01-01"), status: "ACTIVE" } });
      const rules = new ConfigRuleRepository(tx, f.org);
      await tx.configRule.create({ data: { organizationId: f.org, key: "legacy.unrecognized", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), version: 1, lifecycle: "ACTIVE", reason: "Dedicated preserved legacy metadata", value: { preserved: true } } });
      await rules.createVersion({ key: "finance.expense_allocation", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Dedicated property fallback", value: { default_treatment: "OWNER_PAID" } });
      const allocation = await rules.createVersion({ key: "finance.expense_allocation", scopeType: "agreement", scopeId: agreement.id,
        effectiveFrom: new Date("2026-01-01"), reason: "Dedicated effective agreement policy", value: { default_treatment: "ALVILLAS_PAID" } });
      const reference = await rules.createVersion({ key: "finance.payout_schedule", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2026-01-01"), reason: "Dedicated referenced configured amount", value: { cadence: "MONTHLY", holdback_amount: "600", holdback_currency: "MAD" } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "agreement", scopeId: agreement.id,
        effectiveFrom: new Date("2026-01-01"), reason: "Dedicated configured approval condition", value: { thresholds: [{ key: "configured_reference",
          conditions: { path: "expense.amount", op: ">", value: { config: "finance.payout_schedule", path: "holdback_amount" } }, requires_approval_from: ["manager_owner"] }] } });
      return { allocation, reference };
    });
    const input = { propertyId: f.property.id, category: "maintenance", amount: "1000", currency: "MAD", asOf: new Date("2026-10-26T00:00:00Z") };
    const first = await evaluateExpensePolicy(await actor(f), input, { db });
    expect(first.allocationRule.configRuleId).toBe(source.allocation.id); expect(first.allocation.alvillasAmount.toJSON().amount).toBe("1000.00");
    expect(first.approval.requiredSteps).toEqual(["manager_owner"]); expect(first.configReferences[0].configRuleId).toBe(source.reference.id);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.payout_schedule", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2026-10-27"), reason: "Dedicated future policy version", value: { cadence: "MONTHLY", holdback_amount: "1200", holdback_currency: "MAD" } }));
    expect((await evaluateExpensePolicy(await actor(f), input, { db })).configReferences[0].configRuleId).toBe(source.reference.id);
    expect((await evaluateExpensePolicy(await actor(f), { ...input, asOf: new Date("2026-10-28") }, { db })).approval.requiredSteps).toEqual([]);
    expect(first.configReferences[0].version).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.configRule.findFirstOrThrow({ where: { key: "legacy.unrecognized" } }))).toMatchObject({ value: { preserved: true } });
  });
});
