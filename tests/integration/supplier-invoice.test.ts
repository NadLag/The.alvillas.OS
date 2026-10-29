import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createSupplier, setSupplierArchived } from "@/modules/finance/application/supplier-service";
import { SupplierRepository } from "@/modules/finance/infrastructure/supplier-repository";
import { supplierInvoiceFields } from "@/modules/finance/domain/supplier-invoice";
import { getSupplierInvoicePolicyPreview } from "@/modules/finance/application/supplier-invoice-policy";
import { ExpensePolicyUnavailableError } from "@/modules/finance/application/expense-submission-policy";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinancePolicyContextChangedError } from "@/modules/finance/application/finance-config-service";
import { captureReservationCommissionSnapshots } from "@/platform/reservations/finance";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { CompanyLedgerRepository } from "@/modules/finance/infrastructure/company-ledger-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { z } from "zod";
import { createSupplierInvoice, updateSupplierInvoice, getSupplierInvoice, listSupplierInvoices, setSupplierInvoiceArchived, getSupplierInvoiceChoices, SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "@/modules/finance/application/supplier-invoice-service";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
async function fixture() {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated invoice source tenant" } });
  await ensureStandardIdentitySetup(org, { db });
  const source = await withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Invoice source author" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const role = await tx.role.create({ data: { organizationId: org, key: `invoice_qa_${randomUUID()}`, name: "Invoice source author" } });
    for (const key of ["supplier:view", "supplier:create", "supplier:edit", "supplier_invoice:view", "supplier_invoice:create", "supplier_invoice:edit", "property:view", "reservation:view", "audit_log:view"]) {
      const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: org, key } });
      await tx.rolePermission.create({ data: { organizationId: org, roleId: role.id, permissionId: permission.id } });
    }
    const assignment = await tx.roleAssignment.create({ data: { organizationId: org, userAccountId: account.id, personId: person.id, roleId: role.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Invoice source villa", addressLine1: "Local acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    return { account, assignment, property };
  });
  const ctx = { organizationId: org, actorId: source.account.id, personId: source.account.personId, authContext: await authContextForAccount(org, source.account.id, { db }) };
  const supplier = await createSupplier(ctx, { idempotencyKey: randomUUID(), displayName: "Actual invoice supplier", category: "Maintenance", reason: "Dedicated actual invoice supplier" }, { db });
  return { org, ...source, ctx, supplier };
}
const input = (supplierId: string) => ({ supplierId, invoiceNumber: `INV-${randomUUID()}`, issuedOn: "2026-10-28", currency: "MAD", purpose: "Dedicated actual supplier invoice", lines: [{ category: "maintenance", amount: "2400.00" }], idempotencyKey: randomUUID(), reason: "Dedicated supplier invoice acceptance" });
const update = (created: ReturnType<typeof input>, id: string, expectedVersion: number) => {
  return { ...supplierInvoiceFields.strip().parse(created), reason: created.reason, id, expectedVersion };
};
async function invoicePolicyFixture({ calendar = true }: { calendar?: boolean } = {}) {
  const f = await fixture();
  const policySource = await withTenant(db, f.org, async tx => {
    const keys = ["supplier_invoice:approve", "supplier_invoice:reject"];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.assignment.roleId, permissionId: permission.id })) });
    const financialRole = await tx.role.create({ data: { organizationId: f.org, key: "invoice_financial_sources", name: "Independent invoice financial sources" } });
    const financialPermissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["financial_transaction:view", "company_ledger:view"] } } });
    expect(financialPermissions).toHaveLength(2);
    await tx.rolePermission.createMany({ data: financialPermissions.map(permission => ({ organizationId: f.org, roleId: financialRole.id, permissionId: permission.id })) });
    const financialGrant = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: financialRole.id, userAccountId: f.account.id,
      personId: f.account.personId, scopeType: "organization", validFrom: new Date("2000-01-01") } });
    if (calendar) await tx.organizationProfile.create({ data: { organizationId: f.org, brandName: "Dedicated invoice policy", timezone: "Europe/Paris" } });
    await tx.property.update({ where: { id: f.property.id }, data: { timezone: "Europe/Paris" } });
    const owner = await tx.owner.create({ data: { organizationId: f.org, displayName: "Actual invoice owner" } });
    await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: owner.id } });
    const rules = new ConfigRuleRepository(tx, f.org);
    await rules.createVersion({ key: "finance.expense_treatment", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), reason: "Actual company invoice allocation", value: { default_treatment: "ALVILLAS_PAID" } });
    await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"), reason: "Actual property invoice allocation", value: { default_treatment: "OWNER_PAID" } });
    await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), reason: "Explicit invoice approval policy", value: { thresholds: [] } });
    await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), reason: "Dedicated configured journal calendar", value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 } });
    return { owner, financialGrant };
  });
  return { ...f, ...policySource, ctx: { ...f.ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) } };
}
async function policyPreview(f: Awaited<ReturnType<typeof invoicePolicyFixture>>, lines: Array<{ category: string; amount: string; propertyId?: string; reservationId?: string }>) {
  const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines }, { db });
  const command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false };
  return { invoice, command, plan: await getSupplierInvoicePolicyPreview(f.ctx, command, { db }) };
}
async function companyRevenueFacts(f: Awaited<ReturnType<typeof invoicePolicyFixture>>) {
  return withTenant(db, f.org, async tx => {
    const repository = new FinanceRepository(tx, f.org), accounts = [];
    for (const [code, accountType, normalSide] of [["INVOICE_COMPANY_BANK", "ASSET_LOCATION", "DEBIT"], ["INVOICE_COMPANY_INCOME", "ALVILLAS_OWN", "CREDIT"],
      ["INVOICE_OWNER_FUNDS", "CLAIM_OWNERSHIP", "CREDIT"], ["INVOICE_GUEST_FUNDS", "CLAIM_OWNERSHIP", "CREDIT"], ["INVOICE_COMPANY_EXPENSE", "ALVILLAS_OWN", "DEBIT"]] as const)
      accounts.push(await repository.ensureLedgerAccount({ code, name: code, accountType, normalSide }));
    await tx.currency.upsert({ where: { code: "USD" }, update: {}, create: { code: "USD", name: "Dollar", minorUnit: 2 } });
    const [bank, income, owner, guest, expense] = accounts;
    const create = async (accountId: string, value: string, currency = "MAD", occurredAt = new Date("2026-10-28T12:00:00Z")) => {
      const amount = Money.of(value, currency), idempotencyKey = randomUUID();
      const transaction = await repository.createFinancialTransaction({ reference: "INVOICE-POLICY:" + idempotencyKey, description: "Actual company approval revenue source", idempotencyKey,
        occurredAt, createdBy: f.account.id, postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "POLICY_SOURCE", dimensions: {} },
          { ledgerAccountId: accountId, side: "CREDIT", amount, bucket: "POLICY_SOURCE", dimensions: {} }] });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "integration.invoice_policy_revenue_recorded", resourceType: "financial_transaction",
        resourceId: transaction.id, after: { amount: amount.toJSON() }, reason: "Dedicated actual approval revenue source", requestId: randomUUID(), occurredAt: await repository.clock() });
      return transaction;
    };
    await create(income.id, "6000"); const reversible = await create(income.id, "4000");
    await create(owner.id, "1000000"); await create(guest.id, "500000"); await create(expense.id, "200000");
    await create(income.id, "700000", "USD"); await create(income.id, "800000", "MAD", new Date("2026-09-28T12:00:00Z"));
    await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
      reason: "Explicit company income percentage source", value: { revenue_period: { unit: "MONTH" }, revenue_source: { basis: "COMPANY_ACCOUNTS", account_codes: [income.code] },
        thresholds: [{ key: "half_company_income", percentage_of_revenue_bps: 5000, requires_approval_from: ["finance"] }],
        routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } });
    return { bank, income, owner, guest, expense, reversible };
  });
}

describe("immutable supplier invoice authoring on PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });
  it("plans actual mixed property/company costs with explicit economic dates without an expense, approval or money movement", async () => {
    const f = await invoicePolicyFixture(), { invoice, command, plan } = await policyPreview(f, [
      { category: "maintenance", amount: "2400.00", propertyId: f.property.id }, { category: "office", amount: "100.25" }]);
    expect(plan.stages).toEqual([]);
    expect(plan.snapshot).toMatchObject({ invoiceId: invoice.id, sourceInvoiceVersion: 0, occurredOn: command.occurredOn, amount: { amount: "2500.25", currency: "MAD" },
      lines: [{ propertyId: f.property.id, policy: { timezone: "Europe/Paris", allocation: { owner: { amount: "2400.00" }, alvillas: { amount: "0.00" } } } },
        { propertyId: null, policy: { propertyId: null, allocation: { owner: { amount: "0.00" }, alvillas: { amount: "100.25" } }, policies: [{ organizationId: f.org }] } }] });
    const original = JSON.stringify(plan);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-02"), reason: "Later version cannot edit a prepared policy object", value: { default_treatment: "ALVILLAS_PAID" } }));
    expect((await getSupplierInvoicePolicyPreview(f.ctx, command, { db })).snapshot).toMatchObject({ lines: [{ policy: { allocation: { alvillas: { amount: "2400.00" } } } }, {}] });
    expect(JSON.stringify(plan)).toBe(original);
    await withTenant(db, f.org, async tx => {
      expect(await tx.expense.count()).toBe(0); expect(await tx.approvalRequest.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
      expect(await tx.supplierInvoiceRevision.count()).toBe(1); expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).state).toBe("DRAFT");
    });
  });
  it("requires current and caller financial source authority and an actual configured company calendar", async () => {
    const f = await invoicePolicyFixture(), { command } = await policyPreview(f, [{ category: "office", amount: "100" }]);
    const without = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:view")) } };
    await expect(getSupplierInvoicePolicyPreview(without, command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const unconfigured = await invoicePolicyFixture({ calendar: false });
    const missingCalendar = await createSupplierInvoice(unconfigured.ctx, input(unconfigured.supplier.id), { db });
    await expect(getSupplierInvoicePolicyPreview(unconfigured.ctx, { ...command, id: missingCalendar.id }, { db })).rejects.toBeInstanceOf(ExpensePolicyUnavailableError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
    await expect(getSupplierInvoicePolicyPreview(f.ctx, command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
  });
  it("rejects propertyless owner/guest allocations and owner routing instead of inventing a property or owner", async () => {
    const f = await invoicePolicyFixture(), { command } = await policyPreview(f, [{ category: "office", amount: "100" }]);
    for (const treatment of ["OWNER_PAID", "GUEST_PAID"]) {
      await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "organization",
        effectiveFrom: new Date("2020-01-02"), reason: "Invalid propertyless allocation must fail closed", value: { default_treatment: treatment } }));
      await expect(getSupplierInvoicePolicyPreview(f.ctx, command, { db })).rejects.toBeInstanceOf(ExpensePolicyUnavailableError);
    }
    await withTenant(db, f.org, async tx => {
      const rules = new ConfigRuleRepository(tx, f.org);
      await rules.createVersion({ key: "finance.expense_treatment", scopeType: "organization", effectiveFrom: new Date("2020-01-03"), reason: "Restore actual company allocation", value: { default_treatment: "ALVILLAS_PAID" } });
      await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"), reason: "Invalid propertyless owner routing", value: { thresholds: [{ key: "owner", requires_approval_from: ["owner"] }] } });
    });
    await expect(getSupplierInvoicePolicyPreview(f.ctx, command, { db })).rejects.toBeInstanceOf(ExpensePolicyUnavailableError);
  });
  it("uses original booking agreement allocations after current ownership and company policy changes", async () => {
    const f = await invoicePolicyFixture();
    const reservation = await withTenant(db, f.org, async tx => {
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.commission", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Actual original booking invoice agreement", value: { rate_bps: 2000, basis: "GROSS_ACCOMMODATION", accrual_event: "ON_RECEIPT",
          expense_treatments: { default_treatment: "ALVILLAS_PAID" }, approval_thresholds: { thresholds: [] } } });
      const row = await tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: randomUUID(), source: "DIRECT", status: "CONFIRMED",
        guestName: "Actual invoice agreement guest", checkIn: new Date("2026-10-26"), checkOut: new Date("2026-10-28"), nights: 2, idempotencyKey: randomUUID(), confirmedAt: new Date("2026-10-20") } });
      await captureReservationCommissionSnapshots(tx, f.org, row.id, f.account.id);
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id }, data: { archivedAt: new Date() } });
      const replacement = await tx.owner.create({ data: { organizationId: f.org, displayName: "Later invoice owner" } });
      await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: replacement.id } });
      return row;
    });
    const { plan } = await policyPreview(f, [{ propertyId: f.property.id, reservationId: reservation.id, category: "maintenance", amount: "2400" }]);
    expect(plan.snapshot).toMatchObject({ lines: [{ policy: { policies: [{ ownerId: f.owner.id, allocation: { treatment: "ALVILLAS_PAID" } }],
      allocation: { owner: { amount: "0.00" }, alvillas: { amount: "2400.00" } } } }] });
  });
  it("uses the entire invoice threshold and routes each owner's actual share to independently scoped reviewers", async () => {
    const f = await invoicePolicyFixture();
    const reviewers = await withTenant(db, f.org, async tx => {
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id }, data: { shareBps: 5000 } });
      const second = await tx.owner.create({ data: { organizationId: f.org, displayName: "Actual second invoice owner" } });
      await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: second.id, shareBps: 5000, isPrimary: false } });
      const role = await tx.role.create({ data: { organizationId: f.org, key: "scoped_invoice_review", name: "Owner invoice review" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["supplier_invoice:view", "supplier_invoice:approve", "supplier_invoice:reject"] } } });
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
      const reviewers = [];
      for (const ownerId of [f.owner.id, second.id]) {
        const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Actual owner invoice reviewer" } });
        const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id, email: `invoice-review-${randomUUID()}@example.test` } });
        await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: role.id,
          scopeType: "owner", scopeId: ownerId, conditions: { maxAmount: "600.25" }, validFrom: new Date("2000-01-01") } });
        reviewers.push({ person, account, ownerId });
      }
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Entire invoice requires ordered review without exposing another owner's amount", value: {
          thresholds: [{ key: "whole_invoice", amount: "2000", currency: "MAD", requires_approval_from: ["manager_owner"] }],
          routing: { manager: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] },
            owner: { people: reviewers.map(reviewer => reviewer.person.id), roles: [], assigned: false, channels: ["in_app"] } } } });
      return reviewers;
    });
    const { plan } = await policyPreview(f, [{ propertyId: f.property.id, category: "maintenance", amount: "1200.50" }, { category: "office", amount: "1300.50" }]);
    expect(plan.stages).toHaveLength(4);
    expect(plan.stages.map(stage => stage.kind)).toEqual(["manager", "owner", "manager", "owner"]);
    for (const reviewer of reviewers) expect(plan.stages.find(stage => stage.kind === "owner" && stage.ownerId === reviewer.ownerId)).toMatchObject({
      amount: "600.25", propertyId: f.property.id, recipients: [reviewer.account.id] });
    for (const stage of plan.stages) expect(stage.amount).toBe("600.25");
  });
  it("prepares all 500 actual property allocations without truncating the invoice or creating financial rows", async () => {
    const f = await invoicePolicyFixture();
    const properties = await withTenant(db, f.org, async tx => {
      const ids = Array.from({ length: 500 }, () => randomUUID());
      await tx.property.createMany({ data: ids.map((id, index) => ({ id, organizationId: f.org, name: `Invoice allocation ${index}`, addressLine1: "Local scale test", city: "Marrakech",
        timezone: "Europe/Paris", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] })) });
      await tx.propertyOwner.createMany({ data: ids.map(propertyId => ({ organizationId: f.org, propertyId, ownerId: f.owner.id })) });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
        reason: "Explicit allocation across the actual five hundred properties", value: { default_treatment: "OWNER_PAID" } });
      return ids;
    });
    const { plan } = await policyPreview(f, properties.map(propertyId => ({ propertyId, category: "maintenance", amount: "0.01" })));
    const snapshot = z.object({ amount: z.object({ amount: z.string() }), lines: z.array(z.object({ id: z.uuid(), propertyId: z.uuid(), policy: z.object({ allocation: z.object({ owner: z.object({ amount: z.string() }) }) }) })) }).parse(plan.snapshot);
    expect(snapshot.lines).toHaveLength(500); expect(new Set(snapshot.lines.map(line => line.id)).size).toBe(500);
    expect(snapshot.lines.map(line => line.propertyId)).toEqual(properties);
    expect(snapshot.lines.reduce((total, line) => total.add(Money.of(line.policy.allocation.owner.amount, "MAD")), Money.zero("MAD")).toJSON().amount).toBe("5.00");
    expect(snapshot.amount.amount).toBe("5.00");
    await withTenant(db, f.org, async tx => { expect(await tx.expense.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("uses only configured company income in the correct calendar/currency and includes exact reversing movements", async () => {
    const f = await invoicePolicyFixture(), facts = await companyRevenueFacts(f), { command, plan } = await policyPreview(f, [{ category: "office", amount: "4000" }]);
    expect(plan.stages).toHaveLength(0);
    expect(plan.snapshot).toMatchObject({ lines: [{ policy: { policies: [{ revenueEvidence: { source: { basis: "COMPANY_ACCOUNTS", account_codes: [facts.income.code] },
      amount: { amount: "10000.00", currency: "MAD" }, startsAt: "2026-09-30T22:00:00.000Z", endsAt: "2026-10-31T23:00:00.000Z" } }] } }] });
    await withTenant(db, f.org, async tx => {
      const repository = new FinanceRepository(tx, f.org), original = facts.reversible;
      const reversed = await repository.createFinancialTransaction({ reference: "INVOICE-POLICY-REVERSAL:" + randomUUID(), description: "Exact company income reversal", idempotencyKey: randomUUID(),
        occurredAt: new Date("2026-10-28T13:00:00Z"), createdBy: f.account.id, reversesTransactionId: original.id, postings: original.postings.map(line => ({ ledgerAccountId: line.ledgerAccountId,
          side: line.side === "CREDIT" ? "DEBIT" : "CREDIT", amount: Money.of(line.amount.toString(), line.currency), bucket: line.bucket, dimensions: z.record(z.string(), z.unknown()).parse(line.dimensions) })) });
      await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "integration.invoice_policy_revenue_reversed", resourceType: "financial_transaction",
        resourceId: reversed.id, after: { transactionId: original.id, reversalTransactionId: reversed.id }, reason: "Dedicated actual company revenue reversal", requestId: randomUUID(), occurredAt: await repository.clock() });
    });
    const changed = await getSupplierInvoicePolicyPreview(f.ctx, command, { db });
    expect(changed.stages).toMatchObject([{ kind: "finance", ownerId: null, propertyId: null, amount: "4000.00", recipients: [f.account.id] }]);
    expect(changed.snapshot).toMatchObject({ lines: [{ policy: { policies: [{ revenueEvidence: { amount: { amount: "6000.00" } } }] } }] });
    const other = await invoicePolicyFixture(); await companyRevenueFacts(other);
    const window = { accountCodes: [facts.income.code], currency: "MAD", startsAt: new Date("2026-09-30T22:00:00Z"), endsAt: new Date("2026-10-31T23:00:00Z") };
    expect(await withTenant(db, f.org, tx => new CompanyLedgerRepository(tx, f.org).revenue(window))).toBe("6000");
    expect(await withTenant(db, other.org, tx => new CompanyLedgerRepository(tx, other.org).revenue(window))).toBe("10000");
    await expect(getSupplierInvoicePolicyPreview(other.ctx, command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    for (const account of [facts.bank, facts.owner, facts.guest, facts.expense]) await expect(withTenant(db, f.org, tx => new CompanyLedgerRepository(tx, f.org).revenue({
      accountCodes: [account.code], currency: "MAD" }))).rejects.toThrow("Configured company revenue accounts are unavailable");
  });
  it("requires independent company-ledger authority before reading revenue and rechecks financial source revocation after the read", async () => {
    const f = await invoicePolicyFixture(); await companyRevenueFacts(f);
    const { command } = await policyPreview(f, [{ category: "office", amount: "4000" }]);
    const without = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "company_ledger:view")) } };
    const observe = vi.spyOn(CompanyLedgerRepository.prototype, "revenue");
    try { await expect(getSupplierInvoicePolicyPreview(without, command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError); expect(observe).not.toHaveBeenCalled(); }
    finally { observe.mockRestore(); }
    const original = Object.getOwnPropertyDescriptor(CompanyLedgerRepository.prototype, "revenue")?.value as CompanyLedgerRepository["revenue"];
    if (typeof original !== "function") throw Error("The actual company revenue reader is required");
    const revoke = vi.spyOn(CompanyLedgerRepository.prototype, "revenue").mockImplementation(async function (this: CompanyLedgerRepository, value) {
      const result = await original.call(this, value);
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
      return result;
    });
    try { await expect(getSupplierInvoicePolicyPreview(f.ctx, command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError); expect(revoke).toHaveBeenCalledOnce(); }
    finally { revoke.mockRestore(); }
    await withTenant(db, f.org, async tx => { expect(await tx.financialTransaction.count()).toBe(7); expect(await tx.expense.count()).toBe(0); expect(await tx.approvalRequest.count()).toBe(0); });
  });
  it("rejects unspecified company percentage revenue sources instead of substituting owner revenue", async () => {
    const f = await invoicePolicyFixture(), { command } = await policyPreview(f, [{ category: "office", amount: "4000" }]);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
      reason: "Company percentage source must be explicitly configured", value: { revenue_period: { unit: "MONTH" }, thresholds: [{ key: "company_income", percentage_of_revenue_bps: 5000, requires_approval_from: ["finance"] }] } }));
    await expect(getSupplierInvoicePolicyPreview(f.ctx, command, { db })).rejects.toThrow("Company percentage approval requires explicit company revenue accounts");
  });
  it("does not let a single invoice-record grant disclose a whole property's financial policy", async () => {
    const f = await invoicePolicyFixture(), { command } = await policyPreview(f, [{ propertyId: f.property.id, category: "maintenance", amount: "10" }]);
    const caller = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: f.ctx.authContext.assignments?.map(assignment => assignment.scope.scopeType === "organization" &&
      assignment.permissions.has("financial_transaction:view") ? { ...assignment, scope: { organizationId: f.org, scopeType: "financial_record" as const, scopeId: command.id } } : assignment) } };
    await expect(getSupplierInvoicePolicyPreview(caller, command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
  });
  it("evaluates approval role conditions against both current and caller roles without restoring an exemption", async () => {
    const f = await invoicePolicyFixture();
    const grant = await withTenant(db, f.org, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "trusted_invoice_role", name: "Explicit configured invoice exception" } });
      const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "supplier_invoice:view" } });
      await tx.rolePermission.create({ data: { organizationId: f.org, roleId: role.id, permissionId: permission.id } });
      const grant = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.account.personId,
        scopeType: "organization", validFrom: new Date("2000-01-01") } });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
        reason: "Only a current explicit configured role exempts review", value: { thresholds: [{ key: "configured_exception", requires_approval_from: ["finance"],
          conditions: { not: { path: "actor.roles", op: "contains", value: role.key } } }],
          routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } });
      return grant;
    });
    const ctx = { ...f.ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
    const invoice = await createSupplierInvoice(ctx, input(f.supplier.id), { db }), command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false };
    expect((await getSupplierInvoicePolicyPreview(ctx, command, { db })).stages).toHaveLength(0);
    const caller = { ...ctx, authContext: { ...ctx.authContext, assignments: ctx.authContext.assignments?.filter(assignment => assignment.roleKey !== "trusted_invoice_role") } };
    await expect(getSupplierInvoicePolicyPreview(caller, command, { db })).rejects.toBeInstanceOf(FinancePolicyContextChangedError);
    const actualRead = Object.getOwnPropertyDescriptor(ConfigRuleRepository.prototype, "scopedSnapshot")?.value as ConfigRuleRepository["scopedSnapshot"];
    if (typeof actualRead !== "function") throw Error("The actual configuration snapshot reader is required");
    const revoke = vi.spyOn(ConfigRuleRepository.prototype, "scopedSnapshot").mockImplementation(async function (this: ConfigRuleRepository, ...args) {
      const snapshot = await actualRead.apply(this, args);
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: grant.id }, data: { archivedAt: new Date() } }));
      return snapshot;
    });
    try { await expect(getSupplierInvoicePolicyPreview(ctx, command, { db })).rejects.toBeInstanceOf(FinancePolicyContextChangedError); expect(revoke).toHaveBeenCalledOnce(); }
    finally { revoke.mockRestore(); }
    await expect(getSupplierInvoicePolicyPreview(ctx, command, { db })).rejects.toBeInstanceOf(FinancePolicyContextChangedError);
    const refreshed = { ...ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
    expect((await getSupplierInvoicePolicyPreview(refreshed, command, { db })).stages).toMatchObject([{ kind: "finance" }]);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-03"),
      reason: "A current role may also add a mandatory approval", value: { thresholds: [{ key: "mandatory_role", requires_approval_from: ["finance"],
        conditions: { path: "actor.roles", op: "contains", value: "mandatory_invoice_review" } }],
        routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } }));
    expect((await getSupplierInvoicePolicyPreview(refreshed, command, { db })).stages).toHaveLength(0);
    await withTenant(db, f.org, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "mandatory_invoice_review", name: "Explicit additional invoice review" } });
      const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "supplier_invoice:view" } });
      await tx.rolePermission.create({ data: { organizationId: f.org, roleId: role.id, permissionId: permission.id } });
      await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.account.personId,
        scopeType: "organization", validFrom: new Date("2000-01-01") } });
    });
    await expect(getSupplierInvoicePolicyPreview(refreshed, command, { db })).rejects.toBeInstanceOf(FinancePolicyContextChangedError);
    const mandatory = { ...ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
    expect((await getSupplierInvoicePolicyPreview(mandatory, command, { db })).stages).toMatchObject([{ kind: "finance" }]);
  });
  it("rejects an edit if its supplier is archived while the source lock blocks the command", async () => {
    const f = await fixture(), creation = input(f.supplier.id), invoice = await createSupplierInvoice(f.ctx, creation, { db });
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await new SupplierRepository(tx, f.org).lock(f.supplier.id);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid;
      locked(); await gate;
      await setSupplierArchived(f.ctx, { id: f.supplier.id, expectedVersion: 0, archived: true, reason: "Supplier archived during invoice wait" }, { db: { $transaction: work => work(tx) } });
    });
    await ready;
    const editing = updateSupplierInvoice(f.ctx, { ...update(creation, invoice.id, 0), purpose: "Archived supplier edit must roll back" }, { db })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => {
        const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 10000 });
    } finally { release(); await holder; }
    const result = await editing; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(admin, f.org, tx => tx.supplierInvoiceRevision.count({ where: { organizationId: f.org } }))).toBe(1);
  });
  it("rolls back the new revision if stored authority is revoked during a real invoice row wait", async () => {
    const f = await fixture(), creation = input(f.supplier.id), invoice = await createSupplierInvoice(f.ctx, creation, { db });
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM supplier_invoice WHERE organization_id=${f.org}::uuid AND id=${invoice.id}::uuid FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid;
      locked(); await gate;
    });
    await ready;
    const editing = updateSupplierInvoice(f.ctx, { ...update(creation, invoice.id, 0), purpose: "Revoked invoice edit must roll back" }, { db })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => {
        const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`);
        expect(row.waiting).toBe(true);
      }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await editing; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(admin, f.org, async tx => {
      expect(await tx.supplierInvoiceRevision.count({ where: { organizationId: f.org } })).toBe(1); expect(await tx.supplierInvoiceLine.count({ where: { organizationId: f.org } })).toBe(1);
      expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).version).toBe(0);
      expect(await tx.auditLog.count({ where: { resourceId: invoice.id } })).toBe(1);
    });
  });
  it("creates one attributed invoice under concurrent retries and rejects changed intent and duplicate supplier invoice numbers", async () => {
    const f = await fixture(), creation = input(f.supplier.id);
    const rows = await Promise.all(Array.from({ length: 4 }, () => createSupplierInvoice(f.ctx, creation, { db })));
    expect(new Set(rows.map(row => row.id)).size).toBe(1);
    const invoice = await getSupplierInvoice(f.ctx, rows[0].id, {}, { db });
    expect(invoice).toMatchObject({ reference: "SINV-0001", version: 0, invoiceNumber: creation.invoiceNumber, amount: "2400.00", dueOn: null, lines: [{ amount: "2400.00" }] });
    await expect(createSupplierInvoice(f.ctx, { ...creation, lines: [{ category: "maintenance", amount: "2400.0" }] }, { db })).resolves.toMatchObject({ id: invoice.id, idempotent: true });
    await expect(createSupplierInvoice(f.ctx, { ...creation, purpose: "Changed actual invoice intent" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await expect(createSupplierInvoice(f.ctx, { ...creation, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoice.count()).toBe(1); expect(await tx.supplierInvoiceRevision.count()).toBe(1); expect(await tx.supplierInvoiceLine.count()).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.auditLog.count({ where: { resourceId: invoice.id } })).toBe(1);
    });
  });
  it("honors the configured currency minor unit before saving an invoice source", async () => {
    const f = await fixture();
    await admin.currency.upsert({ where: { code: "JPY" }, update: {}, create: { code: "JPY", name: "Yen", minorUnit: 0 } });
    await expect(createSupplierInvoice(f.ctx, { ...input(f.supplier.id), currency: "JPY", lines: [{ category: "maintenance", amount: "10.01" }] }, { db })).rejects.toThrow(/currency|precision/iu);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), currency: "JPY", lines: [{ category: "maintenance", amount: "10.00" }] }, { db });
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).amount).toBe("10.00");
    expect(await withTenant(db, f.org, tx => tx.supplierInvoice.count())).toBe(1);
  });
  it("retains 500 real property allocations with exact totals and no financial movement at the draft stage", async () => {
    const f = await fixture();
    const properties = Array.from({ length: 500 }, (_, index) => ({ id: randomUUID(), organizationId: f.org, name: `Invoice allocation villa ${index}`, addressLine1: "Local acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] }));
    await withTenant(db, f.org, tx => tx.property.createMany({ data: properties }));
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: properties.map(property => ({ propertyId: property.id, category: "maintenance", amount: "100.01" })) }, { db });
    const details = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    expect(details.lines).toHaveLength(500); expect(details.amount).toBe("50005.00");
    expect(new Set(details.lines.map(line => line.propertyId)).size).toBe(500);
    let page = await getSupplierInvoiceChoices(f.ctx, { kind: "property", mode: "create", query: "Invoice allocation villa" }, { db });
    const found = [...page.options];
    while (page.next) { page = await getSupplierInvoiceChoices(f.ctx, { kind: "property", mode: "create", query: "Invoice allocation villa", after: page.next }, { db }); found.push(...page.options); }
    expect(new Set(found.map(row => row.id)).size).toBe(500);
    const noProperties = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "property:view")) } };
    expect((await getSupplierInvoiceChoices(noProperties, { kind: "property", mode: "create", query: "Invoice allocation villa" }, { db })).options).toEqual([]);
    expect((await getSupplierInvoice(noProperties, invoice.id, {}, { db })).lines.every(line => line.propertyName === null)).toBe(true);
    await expect(getSupplierInvoiceChoices(f.ctx, { kind: "property", mode: "create", query: "Invoice allocation villa", after: randomUUID() }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("pages the full invoice directory and source revision history with stable exact boundaries", async () => {
    const f = await fixture(), created = input(f.supplier.id); let id = "";
    for (let index = 0; index < 53; index++) id = (await createSupplierInvoice(f.ctx, { ...created, idempotencyKey: randomUUID(), invoiceNumber: `INV-PAGE-${String(index).padStart(3, "0")}` }, { db })).id;
    const first = await listSupplierInvoices(f.ctx, {}, { db }), next = await listSupplierInvoices(f.ctx, { after: first.next }, { db });
    expect(first.invoices).toHaveLength(50); expect(next.invoices).toHaveLength(3); expect(next.next).toBeUndefined();
    expect(new Set([...first.invoices, ...next.invoices].map(row => row.id)).size).toBe(53);
    expect((await listSupplierInvoices(f.ctx, { query: "INV-PAGE-001" }, { db })).invoices).toHaveLength(1);
    for (let version = 0; version < 52; version++) await updateSupplierInvoice(f.ctx, { ...update(created, id, version), invoiceNumber: "INV-PAGE-052", purpose: `Versioned invoice ${version}` }, { db });
    const current = await getSupplierInvoice(f.ctx, id, {}, { db }), older = await getSupplierInvoice(f.ctx, id, { beforeVersion: current.historyNext }, { db });
    expect(current.history).toHaveLength(50); expect(older.history).toHaveLength(3);
    expect(new Set([...current.history, ...older.history].map(row => row.id)).size).toBe(53);
    expect((await getSupplierInvoice(f.ctx, id, { revisionId: older.history.at(-1)!.id }, { db })).purpose).toBe(created.purpose);
  });
  it("edits by exact source version and retains every earlier revision, line and audit", async () => {
    const f = await fixture(), creation = input(f.supplier.id), first = await createSupplierInvoice(f.ctx, creation, { db });
    const old = await getSupplierInvoice(f.ctx, first.id, {}, { db });
    const original = await withTenant(db, f.org, tx => tx.supplierInvoiceRevision.findUniqueOrThrow({ where: { id: old.revisionId }, include: { lines: true } }));
    const values = update(creation, first.id, 0);
    const results = await Promise.allSettled(["Updated invoice A", "Updated invoice B"].map(purpose => updateSupplierInvoice(f.ctx, { ...values, purpose,
      lines: [{ category: "maintenance", amount: "2400.01", propertyId: f.property.id }, { category: "office", costCenter: "company", amount: "100.99" }], dueOn: "2026-09-01" }, { db })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && result.reason instanceof SupplierInvoiceConflictError)).toHaveLength(1);
    const current = await getSupplierInvoice(f.ctx, first.id, {}, { db });
    expect(current).toMatchObject({ version: 1, amount: "2501.00", dueOn: "2026-09-01" }); expect(current.history).toHaveLength(2);
    expect((await getSupplierInvoice(f.ctx, first.id, { revisionId: old.revisionId }, { db })).amount).toBe("2400.00");
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRevision.findUniqueOrThrow({ where: { id: original.id }, include: { lines: true } }))).toEqual(original);
    await expect(updateSupplierInvoice(f.ctx, { ...values, expectedVersion: 0 }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
  });
  it("archives and restores without changing source history or creating a financial movement", async () => {
    const f = await fixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    await setSupplierInvoiceArchived(f.ctx, { id: invoice.id, expectedVersion: 0, archived: true, reason: "Dedicated invoice source archive" }, { db });
    expect((await listSupplierInvoices(f.ctx, {}, { db })).invoices).toHaveLength(0);
    expect((await listSupplierInvoices(f.ctx, { includeArchived: true }, { db })).invoices).toHaveLength(1);
    await expect(setSupplierInvoiceArchived(f.ctx, { id: invoice.id, expectedVersion: 1, archived: true, reason: "Repeated invoice archive rejected" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await setSupplierInvoiceArchived(f.ctx, { id: invoice.id, expectedVersion: 1, archived: false, reason: "Dedicated invoice source restore" }, { db });
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).version).toBe(2);
    await withTenant(db, f.org, async tx => { expect(await tx.supplierInvoiceRevision.count()).toBe(1); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("requires current and caller invoice/source grants and denies revoked or narrowed aggregate authority", async () => {
    const f = await fixture(), created = input(f.supplier.id), invoice = await createSupplierInvoice(f.ctx, created, { db });
    const without = (permission: string) => ({ ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== permission)) } });
    for (const key of ["supplier_invoice:view", "supplier:view"]) await expect(getSupplierInvoice(without(key), invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const narrowed = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: f.ctx.authContext.assignments?.map(assignment => ({ ...assignment, scope: { organizationId: f.org, scopeType: "property" as const, scopeId: "*" } })) } };
    await expect(listSupplierInvoices(narrowed, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
    await expect(getSupplierInvoice(f.ctx, invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(updateSupplierInvoice(f.ctx, update(created, invoice.id, 0), { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRevision.count())).toBe(1);
  });
  it("rejects foreign source identities and scopes and keeps invoice audit facts private", async () => {
    const f = await fixture(), other = await fixture();
    await expect(createSupplierInvoice(f.ctx, input(other.supplier.id), { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: [{ propertyId: other.property.id, category: "maintenance", amount: "1" }] }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    await expect(getSupplierInvoice(other.ctx, invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const event = await withTenant(db, f.org, tx => tx.auditLog.findFirstOrThrow({ where: { resourceId: invoice.id } }));
    const actor = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(["audit_log:view"]) } };
    const hidden = presentAuditHistoryRow(actor, event); expect(hidden.after).not.toEqual(event.after); expect(hidden.reason).not.toBe(event.reason);
    const noSupplier = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "supplier:view")) } };
    expect(presentAuditHistoryRow(noSupplier, event).reason).not.toBe(event.reason);
    expect(presentAuditHistoryRow(f.ctx, event).after).toEqual(event.after);
  });
  it("prevents source history mutation, deletion, late lines and mismatched revision pointers", async () => {
    const f = await fixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db }), data = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const line = await withTenant(db, f.org, tx => tx.supplierInvoiceLine.findFirstOrThrow({ where: { revisionId: data.revisionId } }));
    for (const mutate of [
      () => withTenant(db, f.org, tx => tx.supplierInvoiceLine.update({ where: { id: line.id }, data: { amount: "1" } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoiceRevision.delete({ where: { id: data.revisionId } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoice.delete({ where: { id: invoice.id } }))
    ]) await expect(mutate()).rejects.toThrow(/append-only|archived/iu);
    await expect(withTenant(db, f.org, tx => tx.supplierInvoiceLine.create({ data: { organizationId: f.org, revisionId: data.revisionId, position: 2, category: "maintenance", amount: "1", currency: "MAD", createdBy: f.account.id } }))).rejects.toThrow(/conserve/iu);
    await expect(withTenant(db, f.org, tx => tx.$executeRaw(Prisma.sql`UPDATE supplier_invoice SET version=version+1,current_revision_id=${randomUUID()}::uuid WHERE id=${invoice.id}::uuid`))).rejects.toThrow();
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).amount).toBe("2400.00");
  });
});
