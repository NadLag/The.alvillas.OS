import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { createSupplier, setSupplierArchived } from "@/modules/finance/application/supplier-service";
import { SupplierRepository } from "@/modules/finance/infrastructure/supplier-repository";
import { SupplierInvoiceRepository } from "@/modules/finance/infrastructure/supplier-invoice-repository";
import { supplierInvoiceFields } from "@/modules/finance/domain/supplier-invoice";
import { recognizeSupplierInvoice } from "@/modules/finance/application/supplier-invoice-recognition";
import { getSupplierInvoiceRecognitionStatus } from "@/modules/finance/application/supplier-invoice-recognition-status";
import { postSupplierPayment, voidSupplierPayment, getSupplierSettlement } from "@/modules/finance/application/supplier-payment-service";
import { supplierPaymentPostings } from "@/modules/finance/domain/supplier-payable";
import { supplierPaymentInput } from "@/modules/finance/domain/supplier-payment";
import { requestSupplierInvoiceRecognition, executeSupplierInvoiceRecognitionReference, failSupplierInvoiceRecognitionReference } from "@/modules/finance/application/supplier-invoice-recognition-requests";
import { SupplierInvoiceRecognitionRequestRepository } from "@/modules/finance/infrastructure/supplier-invoice-recognition-request-repository";
import { SupplierInvoiceRecognitionRepository } from "@/modules/finance/infrastructure/supplier-invoice-recognition-repository";
import { SupplierPayableRepository } from "@/modules/finance/infrastructure/supplier-payable-repository";
import { closeAccountingPeriod } from "@/modules/finance/application/accounting-period-service";
import { AccountingPeriodClosedError } from "@/modules/finance/domain/accounting-period";
import { getSupplierInvoicePolicyPreview } from "@/modules/finance/application/supplier-invoice-policy";
import { submitSupplierInvoice } from "@/modules/finance/application/supplier-invoice-submission";
import { getSupplierInvoiceNotice } from "@/modules/finance/application/supplier-invoice-notice";
import { getApproval, decideApproval } from "@/platform/approvals/approval-service";
import { ApprovalAccessError, ApprovalConflictError } from "@/platform/approvals/approval";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { AutomationRepository } from "@/platform/automation/repository";
import { automationAdmin, enqueueAutomationEvent, executeAutomationRun, previewAutomation, replayAutomation, saveAutomationRule, AutomationAccessError } from "@/platform/automation/service";
import type { AutomationRule } from "@/platform/automation/rule";
import { consumeAutomationReference } from "@/platform/events/inngest-functions";
import { defaultNotificationPreferences } from "@/platform/notifications/notification-preferences";
import { ownNotificationContext } from "@/platform/notifications/notification";
import { getNotificationPage, openNotification, NotificationAccessError } from "@/platform/notifications/notification-service";
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
async function invoiceOwnerReviewers(f: Awaited<ReturnType<typeof invoicePolicyFixture>>, emergency = false) {
  const reviewers = await withTenant(db, f.org, async tx => {
    await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id }, data: { shareBps: 5000 } });
    const second = await tx.owner.create({ data: { organizationId: f.org, displayName: "Other private invoice owner" } });
    await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: second.id, shareBps: 5000, isPrimary: false } });
    const role = await tx.role.create({ data: { organizationId: f.org, key: "retained_invoice_owner_review", name: "Actual invoice owner source" } });
    const keys = ["supplier_invoice:view", ...(emergency ? [] : ["supplier_invoice:approve", "supplier_invoice:reject"])];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
    const result = [];
    for (const ownerId of [f.owner.id, second.id]) {
      const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Independent actual invoice owner" } });
      const account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } });
      const grant = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: account.id, personId: person.id,
        scopeType: "owner", scopeId: ownerId, conditions: { maxAmount: "600.25" }, validFrom: new Date("2000-01-01") } });
      const preferences = defaultNotificationPreferences();
      await new NotificationRepository(tx, f.org).savePreferences(account.id, { ...preferences, in_app: { ...preferences.in_app, enabled: false, operations: false } });
      result.push({ person, account, grant, ownerId });
    }
    await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-02"), reason: "Independent review of each actual owner allocation", value: {
        thresholds: [{ key: "configured_owner_review", requires_approval_from: [emergency ? "owner" : "manager_owner"], ...(emergency ? { emergency_bypass_owner: true } : {}) }],
        routing: { manager: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] },
          owner: { people: result.map(reviewer => reviewer.person.id), roles: [], assigned: false, channels: ["in_app"] } } } });
    return result;
  });
  return Promise.all(reviewers.map(async reviewer => ({ ...reviewer,
    actor: { organizationId: f.org, accountId: reviewer.account.id, authContext: await authContextForAccount(f.org, reviewer.account.id, { db }) } })));
}

async function invoiceAutomationFixture(extra: Partial<AutomationRule> = {}, review = true, mixed = false, propertyOnly = false) {
  const f = await invoicePolicyFixture();
  await withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { key: { in: ["config_rule:view", "config_rule:configure"] } } });
    expect(permissions).toHaveLength(2);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.assignment.roleId, permissionId: permission.id })) });
    if (review) await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
      reason: "Actual configured invoice automation review", value: { thresholds: [{ key: "actual_review", requires_approval_from: ["finance"] }],
        routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } });
  });
  const actor = { ...f.ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
  const rule: AutomationRule = { name: { en: "Actual supplier invoice review", fr: "Revue de facture fournisseur" }, event: "SupplierInvoiceSubmitted", enabled: true,
    conditions: { all: [] }, actions: [{ key: "review", type: "create_approval_request", title: { en: "Review actual invoice", fr: "Vérifier la facture" },
      details: { en: "Use the actual configured review", fr: "Utiliser la validation configurée" } }], retry: { max_attempts: 2, delay_seconds: 1 }, ...extra };
  const config = await saveAutomationRule(actor, { key: "actual_invoice", lifecycle: "ACTIVE", effectiveFrom: new Date("2020-01-01"),
    rule, reason: "Configured actual organization invoice automation" }, { db });
  const invoice = await createSupplierInvoice(actor, { ...input(f.supplier.id), lines: [{ amount: "2400.00", category: "maintenance", ...(propertyOnly ? { propertyId: f.property.id } : {}) },
    ...(mixed ? [{ amount: "1000.00", category: "maintenance", propertyId: f.property.id }] : [])] }, { db });
  const draft = await getSupplierInvoice(actor, invoice.id, {}, { db });
  const submitted = await submitSupplierInvoice(actor, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
    reason: "Actual organization invoice automation source", lineNotes: Object.fromEntries(draft.lines.map(line => [line.id, "Actual individual invoice review context"])) }, { db });
  const event = await withTenant(db, f.org, tx => tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: {
    organizationId: f.org, idempotencyKey: `supplier-invoice:${submitted.submissionId}:SupplierInvoiceSubmitted` } } }));
  return { ...f, actor, config, invoice, draft, submitted, event };
}

async function invoiceRecognitionFixture({ occurredOn = "2026-10-28", companyLines, propertyOnly = false }: { occurredOn?: string; companyLines?: number; propertyOnly?: boolean } = {}) {
  const f = await invoicePolicyFixture();
  const second = await withTenant(db, f.org, async tx => {
    for (const [roleId, keys] of [[f.assignment.roleId, ["supplier_invoice:pay"]], [f.financialGrant.roleId, ["financial_transaction:create", "financial_transaction:override", "financial_transaction:configure"]]] as const) {
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: [...keys] } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId, permissionId: permission.id })) });
    }
    await tx.property.update({ where: { id: f.property.id }, data: { timezone: "America/Los_Angeles" } });
    await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id }, data: { shareBps: 5000 } });
    const second = await tx.owner.create({ data: { organizationId: f.org, displayName: "Other original recognition co-owner" } });
    await tx.propertyOwner.create({ data: { organizationId: f.org, propertyId: f.property.id, ownerId: second.id, shareBps: 5000, isPrimary: false } }); return second;
  });
  const ctx = { ...f.ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
  const creation = { ...input(f.supplier.id), issuedOn: occurredOn, lines: propertyOnly ? [{ propertyId: f.property.id, category: "maintenance", amount: "2400.01" }] : companyLines === undefined ? [
    { category: "software", costCenter: "office", amount: "920.01" }, { propertyId: f.property.id, category: "maintenance", amount: "2400.01" }
  ] : Array.from({ length: companyLines }, (_, index) => ({ category: "software", costCenter: "source_" + index, amount: "0.01" })) };
  const invoice = await createSupplierInvoice(ctx, creation, { db }), draft = await getSupplierInvoice(ctx, invoice.id, {}, { db });
  const submitted = await submitSupplierInvoice(ctx, { id: invoice.id, expectedVersion: 0, occurredOn, emergency: false, idempotencyKey: randomUUID(),
    reason: "Freeze actual claim recognition costs", lineNotes: Object.fromEntries(draft.lines.map(line => [line.id, "Retain this actual original financial cost"])) }, { db });
  expect(submitted.state).toBe("APPROVED");
  return { ...f, ctx, second, invoice, submitted, draft, command: { id: invoice.id, expectedVersion: submitted.version, idempotencyKey: randomUUID(), reason: "Recognize the actual approved supplier claim" } };
}

async function invoiceSettlementFixture({ propertyOnly = false }: { propertyOnly?: boolean } = {}) {
  const f = await invoiceRecognitionFixture({ propertyOnly });
  const bank = await withTenant(db, f.org, async tx => {
    for (const [roleId, keys] of [[f.assignment.roleId, ["supplier_invoice:void"]], [f.financialGrant.roleId, ["financial_transaction:pay", "financial_transaction:void"]]] as const) {
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: [...keys] } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId, permissionId: permission.id })) });
    }
    return new FinanceRepository(tx, f.org).ensureLedgerAccount({ code: "ACTUAL_SETTLEMENT_BANK", name: "Actual supplier settlement bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
  });
  const ctx = { ...f.ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
  const recognized = await recognizeSupplierInvoice(ctx, f.command, { db });
  const payment = { id: f.invoice.id, expectedVersion: f.submitted.version, fundingAccountId: bank.id, idempotencyKey: randomUUID(),
    amount: "1500.01", currency: "MAD", paidAt: "2026-10-28T12:00:00.000Z", reference: "Actual bank transfer reference", reason: "Record the actual supplier disbursement" };
  return { ...f, ctx, bank, recognized, payment };
}

async function rawSupplierPayment(f: Awaited<ReturnType<typeof invoiceSettlementFixture>>, amount: string, options: { omitAudit?: boolean; receiptAmount?: string } = {}) {
  return withTenant(db, f.org, async tx => {
    const finance = new FinanceRepository(tx, f.org), claim = await finance.ensureLedgerAccount({ code: "SUPPLIER_PAYABLE", name: "Supplier claims", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    const input = supplierPaymentInput.parse({ ...f.payment, amount, idempotencyKey: randomUUID() });
    const journal = await finance.createFinancialTransaction({ reference: `SUPPLIER-PAYMENT:${input.idempotencyKey}`, description: input.reason, occurredAt: new Date(input.paidAt),
      idempotencyKey: `supplier-payment:${input.idempotencyKey}`, createdBy: f.ctx.actorId,
      postings: supplierPaymentPostings({ invoiceId: input.id, supplierId: f.supplier.id, paymentId: input.idempotencyKey, liabilityAccountId: claim.id,
        amount: Money.of(amount, input.currency), outstanding: Money.of("3320.02", input.currency), funding: f.bank }) });
    if (!options.omitAudit) await writeAuditEvent(tx, { organizationId: f.org, actorId: f.ctx.actorId, action: "finance.supplier_payment.posted", resourceType: "financial_transaction", resourceId: journal.id,
      after: { input: { ...input, amount: options.receiptAmount ?? amount }, recognitionId: f.recognized.recognitionId, transactionId: journal.id,
        sourcePeriodId: null, sourcePeriodEventId: null, postedAt: input.paidAt }, reason: input.reason, requestId: randomUUID(), occurredAt: await finance.clock() });
    return journal.id;
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
  it("settles actual recognized costs once across retries, serializes overpayment and exactly reverses a payment", async () => {
    const f = await invoiceSettlementFixture();
    const original = await withTenant(db, f.org, tx => tx.financialTransaction.findMany({ where: { id: { in: f.recognized.transactionIds } }, include: { postings: true } }));
    const first = await Promise.all(Array.from({ length: 4 }, () => postSupplierPayment(f.ctx, f.payment, { db })));
    expect(new Set(first.map(payment => payment.paymentId)).size).toBe(1); expect(first.filter(payment => !payment.idempotent)).toHaveLength(1);
    const attempts = await Promise.allSettled(Array.from({ length: 2 }, () => postSupplierPayment(f.ctx, { ...f.payment, amount: "1000.00", idempotencyKey: randomUUID() }, { db })));
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected" && result.reason instanceof SupplierInvoiceConflictError)).toHaveLength(1);
    expect((await getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).outstanding.amount).toBe("820.01");
    const accepted = attempts.find(result => result.status === "fulfilled"); if (accepted?.status !== "fulfilled") throw Error("An actual payment must succeed");
    const command = { id: f.invoice.id, paymentId: accepted.value.paymentId, reason: "Reverse the actual mistaken disbursement" };
    const reversed = await voidSupplierPayment(f.ctx, command, { db });
    expect(await voidSupplierPayment(f.ctx, command, { db })).toEqual({ ...reversed, idempotent: true });
    expect((await getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).outstanding.amount).toBe("1820.01");
    await expect(voidSupplierPayment(f.ctx, { ...command, reason: "Different intent for the existing reversal" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    const facts = await withTenant(db, f.org, async tx => ({ originals: await tx.financialTransaction.findMany({ where: { id: { in: f.recognized.transactionIds } }, include: { postings: true } }),
      transactions: await tx.financialTransaction.count(), paymentAudits: await tx.auditLog.count({ where: { action: "finance.supplier_payment.posted" } }), reversal: await tx.financialTransaction.findUniqueOrThrow({ where: { id: reversed.reversalTransactionId }, include: { postings: true } }) }));
    expect(facts.originals).toEqual(original); expect(facts.transactions).toBe(5); expect(facts.paymentAudits).toBe(2);
    expect(facts.reversal.postings).toHaveLength(2); expect(facts.reversal.reversesTransactionId).toBe(accepted.value.paymentId);
  });
  it("rejects unaudited and fabricated supplier disbursements at the real deferred database boundary", async () => {
    const f = await invoiceSettlementFixture();
    await expect(rawSupplierPayment(f, "1.00", { omitAudit: true })).rejects.toThrow(/attributed atomic receipt/iu);
    await expect(rawSupplierPayment(f, "1.00", { receiptAmount: "2.00" })).rejects.toThrow(/settles only its claim/iu);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
    expect((await getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).outstanding.amount).toBe("3320.02");
  });
  it("serializes actual raw journal races at the database boundary without permitting an over-settled claim", async () => {
    const f = await invoiceSettlementFixture();
    const results = await Promise.allSettled([rawSupplierPayment(f, "3000.00"), rawSupplierPayment(f, "3000.00")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected" && /cannot oversettle/iu.test(String(result.reason)))).toHaveLength(1);
    expect((await getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).outstanding.amount).toBe("320.02");
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(3);
  });
  it("denies one-cent split payments under a caller cap below the whole approved invoice", async () => {
    const f = await invoiceSettlementFixture(), narrow = { ...f.ctx, authContext: { ...f.ctx.authContext,
      assignments: f.ctx.authContext.assignments!.map(assignment => ({ ...assignment, conditions: { ...assignment.conditions, maxAmount: "2000.00" } })) } };
    await expect(postSupplierPayment(narrow, { ...f.payment, amount: "0.01" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("protects actual foreign-tenant claims and payment history", async () => {
    const f = await invoiceSettlementFixture(), other = await invoiceSettlementFixture();
    await expect(getSupplierSettlement(other.ctx, { id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(postSupplierPayment(other.ctx, { ...other.payment, id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const paid = await postSupplierPayment(f.ctx, f.payment, { db });
    await expect(voidSupplierPayment(other.ctx, { id: other.invoice.id, paymentId: paid.paymentId, reason: "Foreign payment must remain private" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect((await getSupplierSettlement(other.ctx, { id: other.invoice.id }, { db })).outstanding.amount).toBe("3320.02");
  });
  it("rechecks actual payment authority after waiting for its shared invoice lock", async () => {
    const f = await invoiceSettlementFixture(); let locked!: () => void, release!: () => void, blocker = 0;
    const reached = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await new SupplierPayableRepository(tx, f.org).lockInvoice(f.invoice.id);
      const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = pid.pid; locked(); await gate;
    });
    await reached;
    const payment = postSupplierPayment(f.ctx, f.payment, { db }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await payment; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("rejects changed payment intent, foreign invoices, wrong currency, unavailable funding and future disbursements", async () => {
    const f = await invoiceSettlementFixture(); await postSupplierPayment(f.ctx, f.payment, { db });
    await expect(postSupplierPayment(f.ctx, { ...f.payment, amount: "1500.02" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await expect(postSupplierPayment(f.ctx, { ...f.payment, id: randomUUID(), idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(postSupplierPayment(f.ctx, { ...f.payment, currency: "USD", idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(ExpensePolicyUnavailableError);
    await expect(postSupplierPayment(f.ctx, { ...f.payment, paidAt: "2099-01-01T00:00:00Z", idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    await withTenant(db, f.org, tx => tx.ledgerAccount.update({ where: { id: f.bank.id }, data: { archivedAt: new Date() } }));
    await expect(postSupplierPayment(f.ctx, { ...f.payment, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(ExpensePolicyUnavailableError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(3);
  });
  it("retains caller restrictions and denies revoked stored grants before payment replay and private balances", async () => {
    const f = await invoiceSettlementFixture(); await postSupplierPayment(f.ctx, f.payment, { db });
    const narrow = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:pay")) } };
    await expect(postSupplierPayment(narrow, f.payment, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date("2001-01-01") } }));
    await expect(postSupplierPayment(f.ctx, { ...f.payment, amount: "0.01" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
  });
  it("rolls back an actual payment and its audit when stored authority expires after deferred guards", async () => {
    const f = await invoiceSettlementFixture(), original = Reflect.get(SupplierInvoiceRecognitionRepository.prototype, "flushGuards");
    const expire = vi.spyOn(SupplierInvoiceRecognitionRepository.prototype, "flushGuards").mockImplementationOnce(async function (this: SupplierInvoiceRecognitionRepository) {
      await original.call(this);
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date("2001-01-01") } }));
    });
    try { await expect(postSupplierPayment(f.ctx, f.payment, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError); } finally { expire.mockRestore(); }
    const facts = await withTenant(admin, f.org, async tx => ({ journals: await tx.financialTransaction.count({ where: { organizationId: f.org } }), audits: await tx.auditLog.count({ where: { organizationId: f.org, action: "finance.supplier_payment.posted" } }) }));
    expect(facts).toEqual({ journals: 2, audits: 0 });
  });
  it("links an actual closed disbursement to the current open period and requires override authority", async () => {
    const f = await invoiceSettlementFixture();
    const closed = await closeAccountingPeriod(f.ctx, { month: "2026-09", expectedVersion: 0, idempotencyKey: randomUUID(), reason: "Close the actual supplier disbursement month" }, { db });
    const payment = { ...f.payment, paidAt: "2026-09-25T12:00:00Z" };
    await expect(postSupplierPayment(f.ctx, payment, { db })).rejects.toBeInstanceOf(AccountingPeriodClosedError);
    const narrow = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:override")) } };
    await expect(postSupplierPayment(narrow, { ...payment, currentPeriod: true }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    const recorded = await postSupplierPayment(f.ctx, { ...payment, currentPeriod: true }, { db });
    const saved = await withTenant(db, f.org, tx => new SupplierPayableRepository(tx, f.org).paymentAudit(recorded.paymentId));
    expect(saved?.after).toMatchObject({ sourcePeriodId: closed.id, input: { paidAt: "2026-09-25T12:00:00.000Z", currentPeriod: true } });
    expect((await getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).outstanding.amount).toBe("1820.01");
  });
  it("denies reversal when a caller can void the adjusted posting but cannot void the original paid date", async () => {
    const f = await invoiceSettlementFixture({ propertyOnly: true });
    await closeAccountingPeriod(f.ctx, { month: "2026-09", expectedVersion: 0, idempotencyKey: randomUUID(), reason: "Close the actual original paid month" }, { db });
    const paid = await postSupplierPayment(f.ctx, { ...f.payment, paidAt: "2026-09-25T12:00:00Z", currentPeriod: true }, { db });
    const key = "financial_transaction:void", narrow = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: [
      ...f.ctx.authContext.assignments!.map(assignment => ({ ...assignment, permissions: new Set([...assignment.permissions].filter(permission => permission !== key)) })),
      { permissions: new Set([key]), scope: { organizationId: f.org, scopeType: "organization" as const }, conditions: { timeWindow: { startsAt: "2026-10-01T00:00:00Z" } } }
    ] } };
    await expect(voidSupplierPayment(narrow, { id: f.invoice.id, paymentId: paid.paymentId, reason: "A posting adjustment must retain the original date restriction" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
    expect((await getSupplierSettlement(f.ctx, { id: f.invoice.id }, { db })).outstanding.amount).toBe("900.00");
  });
  it("reads actual queued and recorded financial status without exposing captured permissions or private execution keys", async () => {
    const f = await invoiceRecognitionFixture();
    expect(await getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db })).toMatchObject({ recognized: false, pending: false, canRequest: true, history: [] });
    const requested = await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    const pending = await getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db });
    expect(pending).toMatchObject({ recognized: false, pending: true, canRequest: false, amount: "3320.02", currency: "MAD" });
    expect(pending.history[0]).toMatchObject({ id: requested.requestId, state: "PENDING", reason: f.command.reason });
    expect(Object.hasOwn(pending.history[0], "authorizationCap")).toBe(false); expect(Object.hasOwn(pending.history[0], "requestFingerprint")).toBe(false);
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db });
    const recorded = await getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db });
    expect(recorded).toMatchObject({ recognized: true, pending: false, canRequest: false, sourceCosts: 2 });
    expect(recorded.history[0]).toMatchObject({ state: "SUCCEEDED", failureCode: null });
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("allows an independent financial viewer to read recognition status without granting recording authority", async () => {
    const f = await invoiceRecognitionFixture(); await recognizeSupplierInvoice(f.ctx, f.command, { db });
    const caller = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => !["supplier_invoice:pay", "financial_transaction:create", "financial_transaction:override"].includes(key))) } };
    expect(await getSupplierInvoiceRecognitionStatus(caller, { id: f.invoice.id }, { db })).toMatchObject({ recognized: true, canRequest: false });
    await expect(requestSupplierInvoiceRecognition(caller, f.command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
  });
  it("denies invoice-header-only, narrowed financial and foreign-tenant recognition status reads before disclosing state", async () => {
    const f = await invoiceRecognitionFixture();
    const caller = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => !key.startsWith("financial_transaction:"))) } };
    await expect(getSupplierInvoiceRecognitionStatus(caller, { id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await recognizeSupplierInvoice(f.ctx, f.command, { db });
    await expect(getSupplierInvoiceRecognitionStatus(caller, { id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(getSupplierInvoiceRecognitionStatus({ ...f.ctx, organizationId: randomUUID() }, { id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date() } }));
    await expect(getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
  });
  it("rechecks financial viewer authority after an actual source-lock wait", async () => {
    const f = await invoiceRecognitionFixture(); let locked!: () => void, release!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => { await new SupplierInvoiceRepository(tx, f.org).lock(f.invoice.id);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid; locked(); await gate; });
    await ready;
    const reading = getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try { await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await reading; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
  });
  it("pages complete actual recognition request history without fetching private caps or adding a query per request", async () => {
    const f = await invoiceRecognitionFixture(), scoped = new URL(url!); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
    const measured = new PrismaClient({ datasourceUrl: scoped.toString(), log: [{ emit: "event", level: "query" }] }), queries: string[] = [];
    let onCommit: (() => void) | undefined;
    measured.$on("query", query => { queries.push(query.query); if (query.query.trim() === "COMMIT") onCommit?.(); });
    const readStatus = async (before?: string) => {
      queries.length = 0;
      const committed = new Promise<void>(resolve => { onCommit = resolve; });
      const result = await getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id, ...(before ? { before } : {}) }, { db: measured });
      // Prisma query events can follow its returned transaction promise. Include the actual COMMIT in both measurements.
      await committed; onCommit = undefined; return result;
    };
    try {
      const recordFailedRequest = async (index: number) => {
        const request = await requestSupplierInvoiceRecognition(f.ctx, { ...f.command, idempotencyKey: randomUUID(), reason: "Actual authorized recording request " + index }, { db });
        const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested", payload: { path: ["requestId"], equals: request.requestId } } }));
        await failSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db });
      };
      await recordFailedRequest(0);
      await readStatus(); const initialCount = queries.length;
      for (let index = 1; index < 52; index++) await recordFailedRequest(index);
      const first = await readStatus();
      expect(queries.length).toBe(initialCount); expect(first.history).toHaveLength(50); expect(first.next).not.toBeNull();
      const second = await readStatus(first.next!);
      expect(second.history).toHaveLength(2); expect(new Set([...first.history, ...second.history].map(request => request.id)).size).toBe(52);
      expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
    } finally { await measured.$disconnect(); }
  });
  it("offers a closed-period adjustment only to a current independently authorized financial operator", async () => {
    const f = await invoiceRecognitionFixture({ occurredOn: "2026-09-15" });
    await closeAccountingPeriod(f.ctx, { month: "2026-09", expectedVersion: 0, idempotencyKey: randomUUID(), reason: "Close actual original recognition status period" }, { db });
    expect(await getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db })).toMatchObject({ currentPeriod: true, canRequest: true });
    const caller = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:override")) } };
    expect(await getSupplierInvoiceRecognitionStatus(caller, { id: f.invoice.id }, { db })).toMatchObject({ currentPeriod: true, canRequest: false });
    const requested = await requestSupplierInvoiceRecognition(f.ctx, { ...f.command, currentPeriod: true }, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested", payload: { path: ["requestId"], equals: requested.requestId } } }));
    expect(await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db })).toMatchObject({ state: "SUCCEEDED" });
    expect(await getSupplierInvoiceRecognitionStatus(f.ctx, { id: f.invoice.id }, { db })).toMatchObject({ recognized: true, canRequest: false });
  });
  it("durably queues recognition with an immutable caller restriction and no financial movement", async () => {
    const f = await invoiceRecognitionFixture(), requested = await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    expect(z.uuid().parse(requested.requestId)).toBe(requested.requestId);
    expect(requested).toEqual({ requestId: requested.requestId, id: f.invoice.id, state: "PENDING", idempotent: false });
    expect(await requestSupplierInvoiceRecognition(f.ctx, f.command, { db })).toEqual({ ...requested, idempotent: true });
    await withTenant(db, f.org, async tx => {
      const source = await tx.supplierInvoiceRecognitionRequest.findUniqueOrThrow({ where: { id: requested.requestId } });
      expect(source.authorizationCap).toMatchObject({ schemaVersion: 1, userAccountId: f.account.id, organizationId: f.org });
      expect(await tx.supplierInvoiceRecognitionRequest.count()).toBe(1); expect(await tx.financialTransaction.count()).toBe(0);
      expect(await tx.supplierInvoiceRecognitionOutcome.count()).toBe(0);
      const event = await tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } });
      expect(event.payload).toEqual({ requestId: requested.requestId });
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognition_requested", actorId: f.account.id } })).toBe(1);
    });
    await expect(withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionRequest.update({ where: { id: requested.requestId }, data: { reason: "Replaced original request restriction" } }))).rejects.toThrow();
  });
  it("commits one background recognition and success receipt across concurrent delivery and late failure callbacks", async () => {
    const f = await invoiceRecognitionFixture(); await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    const reference = { organizationId: f.org, outboxEventId: event.id };
    const results = await Promise.all(Array.from({ length: 4 }, () => executeSupplierInvoiceRecognitionReference(reference, { db })));
    expect(results.every(result => result.state === "SUCCEEDED")).toBe(true); expect(results.filter(result => !result.idempotent)).toHaveLength(1);
    expect(await failSupplierInvoiceRecognitionReference(reference, { db })).toMatchObject({ state: "SUCCEEDED", idempotent: true });
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoiceRecognition.count()).toBe(1); expect(await tx.supplierInvoiceRecognitionOutcome.count()).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(2); expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognition_completed" } })).toBe(1);
    });
  });
  it("denies background recognition when stored financial authority is revoked after admission", async () => {
    const f = await invoiceRecognitionFixture(); await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date() } }));
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    expect(await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db })).toMatchObject({ state: "DENIED" });
    await withTenant(db, f.org, async tx => {
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.supplierInvoiceRecognition.count()).toBe(0);
      expect(await tx.supplierInvoiceRecognitionOutcome.findFirstOrThrow()).toMatchObject({ state: "DENIED", failureCode: "ACCESS_DENIED", recognitionId: null });
    });
  });
  it("retains original caller expiry when the background account still has wider stored authority", async () => {
    const f = await invoiceRecognitionFixture(), expires = new Date(Date.now() + 2500);
    const caller = { ...f.ctx, authContext: { ...f.ctx.authContext, assignments: f.ctx.authContext.assignments!.map(assignment => ({ ...assignment, validTo: expires })) } };
    await requestSupplierInvoiceRecognition(caller, f.command, { db });
    await withTenant(db, f.org, tx => tx.$executeRaw`SELECT pg_sleep(2.6)`);
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    expect(await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db })).toMatchObject({ state: "DENIED" });
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
    expect((await authContextForAccount(f.org, f.account.id, { db })).permissions.has("financial_transaction:create")).toBe(true);
  });
  it("rolls back financial recognition if its success receipt cannot commit and recovers on redelivery", async () => {
    const f = await invoiceRecognitionFixture(); await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    const reference = { organizationId: f.org, outboxEventId: event.id };
    const failure = vi.spyOn(SupplierInvoiceRecognitionRequestRepository.prototype, "outcome").mockRejectedValueOnce(new Error("Controlled receipt storage interruption"));
    try { await expect(executeSupplierInvoiceRecognitionReference(reference, { db })).rejects.toThrow("Controlled receipt storage interruption"); }
    finally { failure.mockRestore(); }
    await withTenant(db, f.org, async tx => { expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.supplierInvoiceRecognition.count()).toBe(0);
      expect(await tx.supplierInvoiceRecognitionOutcome.count()).toBe(0); expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized" } })).toBe(0); });
    expect(await executeSupplierInvoiceRecognitionReference(reference, { db })).toMatchObject({ state: "SUCCEEDED", idempotent: false });
  });
  it("rejects forged and cross-tenant background references without revealing or completing the real request", async () => {
    const f = await invoiceRecognitionFixture(); await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    for (const reference of [{ organizationId: randomUUID(), outboxEventId: event.id }, { organizationId: f.org, outboxEventId: randomUUID() }])
      await expect(executeSupplierInvoiceRecognitionReference(reference, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    await expect(executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id, payload: { requestId: randomUUID() } }, { db })).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionOutcome.count())).toBe(0);
    await expect(withTenant(db, f.org, tx => tx.outboxEvent.update({ where: { id: event.id }, data: { payload: { requestId: randomUUID() } } }))).rejects.toThrow();
    await withTenant(db, f.org, tx => tx.outboxEvent.update({ where: { id: event.id }, data: { status: "DISPATCHED", processedAt: new Date(), attemptCount: 1 } }));
    expect(await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db })).toMatchObject({ state: "SUCCEEDED" });
  });
  it("rejects request rows without their attributed audit and canonical dispatch event at the database boundary", async () => {
    const f = await invoiceRecognitionFixture();
    for (const includeAudit of [false, true]) await expect(withTenant(db, f.org, async tx => {
      const request = await new SupplierInvoiceRecognitionRequestRepository(tx, f.org).create({ invoiceId: f.invoice.id, submissionId: f.submitted.submissionId,
        invoiceVersion: f.command.expectedVersion, currentPeriod: false, idempotencyKey: randomUUID(), requestFingerprint: "0".repeat(64),
        reason: f.command.reason, authorizationCap: captureAuthorizationCap(f.ctx.authContext), requestedBy: f.account.id });
      if (includeAudit) await writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "finance.supplier_invoice.recognition_requested",
        resourceType: "supplier_invoice", resourceId: f.invoice.id, after: { recognitionRequestId: request.id, submissionId: f.submitted.submissionId },
        reason: f.command.reason, requestId: randomUUID(), occurredAt: await new FinanceRepository(tx, f.org).clock() });
    })).rejects.toThrow();
    await withTenant(db, f.org, async tx => { expect(await tx.supplierInvoiceRecognitionRequest.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognition_requested" } })).toBe(0); });
  });
  it("rejects fabricated success, absent failure codes and unaudited completion receipts", async () => {
    const f = await invoiceRecognitionFixture(), requested = await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    for (const value of [{ state: "SUCCEEDED" as const, recognitionId: randomUUID(), failureCode: null },
      { state: "DENIED" as const, recognitionId: null, failureCode: null }, { state: "DENIED" as const, recognitionId: null, failureCode: "ACCESS_DENIED" }])
      await expect(withTenant(db, f.org, tx => new SupplierInvoiceRecognitionRequestRepository(tx, f.org).outcome({ id: randomUUID(), requestId: requested.requestId, ...value }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionOutcome.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("keeps an exhausted request terminal while a separately authorized new request can complete the same invoice", async () => {
    const f = await invoiceRecognitionFixture(), requested = await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    const reference = { organizationId: f.org, outboxEventId: event.id };
    expect(await failSupplierInvoiceRecognitionReference(reference, { db })).toMatchObject({ requestId: requested.requestId, state: "FAILED", idempotent: false });
    expect(await executeSupplierInvoiceRecognitionReference(reference, { db })).toMatchObject({ state: "FAILED", idempotent: true });
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
    const retry = await requestSupplierInvoiceRecognition(f.ctx, { ...f.command, idempotencyKey: randomUUID() }, { db });
    const retryEvent = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested", payload: { path: ["requestId"], equals: retry.requestId } } }));
    expect(await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: retryEvent.id }, { db })).toMatchObject({ state: "SUCCEEDED" });
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.count())).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionOutcome.count())).toBe(2);
    await expect(withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionOutcome.deleteMany())).rejects.toThrow();
  });
  it("rolls back the claim and success receipt when financial authority expires after the actual receipt insert", async () => {
    const f = await invoiceRecognitionFixture(); await requestSupplierInvoiceRecognition(f.ctx, f.command, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { type: "SupplierInvoiceRecognitionRequested" } }));
    const original = Reflect.get(SupplierInvoiceRecognitionRequestRepository.prototype, "outcome");
    const expire = vi.spyOn(SupplierInvoiceRecognitionRequestRepository.prototype, "outcome").mockImplementationOnce(async function (this: SupplierInvoiceRecognitionRequestRepository, input) {
      const result = await original.call(this, input);
      const tx = Reflect.get(this, "tx") as Prisma.TransactionClient;
      await tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date() } });
      return result;
    });
    try { expect(await executeSupplierInvoiceRecognitionReference({ organizationId: f.org, outboxEventId: event.id }, { db })).toMatchObject({ state: "DENIED" }); }
    finally { expire.mockRestore(); }
    await withTenant(db, f.org, async tx => { expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.supplierInvoiceRecognition.count()).toBe(0);
      expect(await tx.supplierInvoiceRecognitionOutcome.findFirstOrThrow()).toMatchObject({ state: "DENIED", recognitionId: null });
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized" } })).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognition_completed" } })).toBe(1); });
  });
  it("recognizes original co-owner cents and company costs once without physical funding or replacement policy", async () => {
    const f = await invoiceRecognitionFixture();
    await withTenant(db, f.org, async tx => {
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2026-10-01"), reason: "Replacement policy must not rewrite original costs", value: { default_treatment: "ALVILLAS_PAID" } });
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id, ownerId: f.owner.id }, data: { shareBps: 7500 } });
      await tx.propertyOwner.updateMany({ where: { propertyId: f.property.id, ownerId: f.second.id }, data: { shareBps: 2500 } });
    });
    const result = await recognizeSupplierInvoice(f.ctx, f.command, { db }); expect(result.idempotent).toBe(false); expect(result.transactionIds).toHaveLength(2);
    await withTenant(db, f.org, async tx => {
      const postings = await tx.posting.findMany({ where: { transactionId: { in: result.transactionIds } }, include: { ledgerAccount: true } });
      expect(postings).toHaveLength(5); expect(postings.some(posting => ["ASSET", "ASSET_LOCATION", "STAFF_WALLET"].includes(posting.ledgerAccount.accountType))).toBe(false);
      expect(postings.filter(posting => posting.bucket === "OWNER_EXPENSE").map(posting => posting.amount.toFixed(2)).sort()).toEqual(["1200.00", "1200.01"]);
      expect(postings.filter(posting => posting.bucket === "ALVILLAS_EXPENSE").map(posting => posting.amount.toFixed(2))).toEqual(["920.01"]);
      expect((await new SupplierPayableRepository(tx, f.org).outstanding({ supplierId: f.supplier.id, invoiceId: f.invoice.id, currency: "MAD" })).toJSON().amount).toBe("3320.02");
      expect(await tx.expense.count()).toBe(0); expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized" } })).toBe(1);
    });
  });
  it("serializes concurrent actual recognition retries without a second claim", async () => {
    const f = await invoiceRecognitionFixture(), results = await Promise.all(Array.from({ length: 4 }, () => recognizeSupplierInvoice(f.ctx, f.command, { db })));
    expect(results.filter(result => !result.idempotent)).toHaveLength(1); expect(new Set(results.map(result => result.recognitionId)).size).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("retains the original cost order in an actual recognition retry regardless of generated UUID order", async () => {
    const f = await invoiceRecognitionFixture({ companyLines: 50 }), first = await recognizeSupplierInvoice(f.ctx, f.command, { db }),
      again = await recognizeSupplierInvoice(f.ctx, f.command, { db });
    expect(again.idempotent).toBe(true); expect(again.transactionIds).toEqual(first.transactionIds);
    await withTenant(db, f.org, async tx => {
      const original = await tx.supplierInvoiceRecognitionLine.findMany({ where: { recognitionId: first.recognitionId }, orderBy: { invoiceLine: { position: "asc" } } });
      expect(again.transactionIds).toEqual(original.map(line => line.transactionId)); expect(await tx.financialTransaction.count()).toBe(50);
    });
  });
  it.each(["reason", "expectedVersion", "idempotencyKey", "currentPeriod"] as const)("binds recognition retry to the complete %s intent", async key => {
    const f = await invoiceRecognitionFixture(); await recognizeSupplierInvoice(f.ctx, f.command, { db });
    const changed = { ...f.command, [key]: key === "reason" ? "A different actual recognition reason" : key === "expectedVersion" ? f.command.expectedVersion + 1 : key === "currentPeriod" ? true : randomUUID() };
    await expect(recognizeSupplierInvoice(f.ctx, changed, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("keeps caller restrictions independent of wider stored recognition grants", async () => {
    const f = await invoiceRecognitionFixture(), caller = { ...f.ctx, authContext: { ...f.ctx.authContext,
      permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "financial_transaction:create")) } };
    await expect(recognizeSupplierInvoice(caller, f.command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.count())).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("denies narrowed financial source access before disclosing recognition retry conflicts", async () => {
    const f = await invoiceRecognitionFixture(); await recognizeSupplierInvoice(f.ctx, f.command, { db });
    const caller = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => !key.startsWith("financial_transaction:"))) } };
    for (const input of [{ ...f.command, reason: "Different intent must not disclose its private recognition" }, { ...f.command, idempotencyKey: randomUUID() },
      { ...f.command, expectedVersion: f.command.expectedVersion + 1 }, { ...f.command, currentPeriod: true }])
      await expect(recognizeSupplierInvoice(caller, input, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("rolls back actual recognition lines and journals after stored financial authority expires during their write", async () => {
    const f = await invoiceRecognitionFixture(), original = Reflect.get(SupplierInvoiceRecognitionRepository.prototype, "lines");
    const expire = vi.spyOn(SupplierInvoiceRecognitionRepository.prototype, "lines").mockImplementationOnce(async function (this: SupplierInvoiceRecognitionRepository, value) {
      const result = await original.call(this, value);
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date("2020-01-01") } })); return result;
    });
    try { await expect(recognizeSupplierInvoice(f.ctx, f.command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError); expect(expire).toHaveBeenCalledOnce(); }
    finally { expire.mockRestore(); }
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoiceRecognition.count()).toBe(0); expect(await tx.supplierInvoiceRecognitionLine.count()).toBe(0);
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.posting.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized" } })).toBe(0);
    });
  });
  it("refreshes financial authority after the real canonical invoice lock wait", async () => {
    const f = await invoiceRecognitionFixture(); let locked!: () => void, release!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await new SupplierPayableRepository(tx, f.org).lockInvoice(f.invoice.id);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid; locked(); await gate;
    });
    await ready;
    const posting = recognizeSupplierInvoice(f.ctx, f.command, { db }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await posting; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.count())).toBe(0);
  });
  it("refreshes authority after a real journal-batch account-row wait", async () => {
    const f = await invoiceRecognitionFixture();
    const claim = await withTenant(db, f.org, tx => new FinanceRepository(tx, f.org).ensureLedgerAccount({ code: "SUPPLIER_PAYABLE", name: "Actual supplier claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" }));
    let locked!: () => void, release!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM ledger_account WHERE organization_id=${f.org}::uuid AND id=${claim.id}::uuid FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid; locked(); await gate;
    });
    await ready;
    const posting = recognizeSupplierInvoice(f.ctx, f.command, { db }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await posting; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(db, f.org, async tx => { expect(await tx.supplierInvoiceRecognition.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("checks fresh authority after actual deferred journal and source guards complete", async () => {
    const f = await invoiceRecognitionFixture(), original = Reflect.get(SupplierInvoiceRecognitionRepository.prototype, "flushGuards");
    const expire = vi.spyOn(SupplierInvoiceRecognitionRepository.prototype, "flushGuards").mockImplementationOnce(async function (this: SupplierInvoiceRecognitionRepository) {
      await original.call(this);
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
    });
    try { await expect(recognizeSupplierInvoice(f.ctx, f.command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError); expect(expire).toHaveBeenCalledOnce(); }
    finally { expire.mockRestore(); }
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoiceRecognition.count()).toBe(0); expect(await tx.supplierInvoiceRecognitionLine.count()).toBe(0);
      expect(await tx.financialTransaction.count()).toBe(0); expect(await tx.posting.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.recognized" } })).toBe(0);
    });
  });
  it("rejects a new invoice journal without its actual recognized cost link", async () => {
    const f = await invoiceRecognitionFixture(), result = await recognizeSupplierInvoice(f.ctx, f.command, { db });
    const original = await withTenant(db, f.org, tx => tx.financialTransaction.findUniqueOrThrow({ where: { id: result.transactionIds[0] }, include: { postings: true } }));
    await expect(withTenant(db, f.org, tx => new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: "ORPHAN-INVOICE-CLAIM", description: "An unattached source journal must be rejected",
      occurredAt: new Date(), idempotencyKey: randomUUID(), createdBy: f.account.id, postings: original.postings.map(posting => ({ ledgerAccountId: posting.ledgerAccountId,
        side: posting.side as "DEBIT" | "CREDIT", amount: Money.of(posting.amount.toString(), posting.currency), bucket: posting.bucket!, dimensions: posting.dimensions as Record<string, unknown> })) }))).rejects.toThrow(/actual atomic recognized cost source/iu);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("shifts only the closed calendar source with an actual period adjustment and no duplicate expense", async () => {
    const f = await invoiceRecognitionFixture({ occurredOn: "2026-10-01" });
    await closeAccountingPeriod(f.ctx, { month: "2026-09", expectedVersion: 0, idempotencyKey: randomUUID(), reason: "Close the actual original company cost period" }, { db });
    await expect(recognizeSupplierInvoice(f.ctx, f.command, { db })).rejects.toBeInstanceOf(AccountingPeriodClosedError);
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.count())).toBe(0);
    const result = await recognizeSupplierInvoice(f.ctx, { ...f.command, currentPeriod: true }, { db });
    await withTenant(db, f.org, async tx => {
      const links = await tx.supplierInvoiceRecognitionLine.findMany({ where: { recognitionId: result.recognitionId }, include: { invoiceLine: true, transaction: true, periodAdjustment: true } });
      const company = links.find(link => !link.invoiceLine.propertyId)!, property = links.find(link => link.invoiceLine.propertyId)!;
      expect(company.sourceOccurredAt.toISOString()).toBe("2026-09-30T22:00:00.000Z"); expect(company.periodAdjustment?.invoiceRecognitionLineId).toBe(company.id);
      expect(company.periodAdjustment?.expenseId).toBeNull(); expect(company.transaction.occurredAt.getUTCMonth()).toBe(new Date().getUTCMonth());
      expect(property.sourceOccurredAt.toISOString()).toBe("2026-10-01T07:00:00.000Z"); expect(property.transaction.occurredAt).toEqual(property.sourceOccurredAt);
      expect(property.periodAdjustment).toBeNull(); expect(await tx.expense.count()).toBe(0);
    });
  });
  it("requires a genuine closed source for a current-period override", async () => {
    const f = await invoiceRecognitionFixture();
    await expect(recognizeSupplierInvoice(f.ctx, { ...f.command, currentPeriod: true }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("isolates actual recognition sources and claim history by tenant", async () => {
    const f = await invoiceRecognitionFixture(), other = await invoiceRecognitionFixture();
    await recognizeSupplierInvoice(f.ctx, f.command, { db });
    await expect(recognizeSupplierInvoice(other.ctx, f.command, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
    expect(await withTenant(db, other.org, tx => tx.supplierInvoiceRecognition.findMany({ where: { organizationId: f.org } }))).toEqual([]);
    expect(await withTenant(db, other.org, tx => tx.supplierInvoiceRecognitionLine.findMany({ where: { organizationId: f.org } }))).toEqual([]);
  });
  it("enforces complete atomic recognition and append-only source-to-journal links in PostgreSQL", async () => {
    const f = await invoiceRecognitionFixture();
    await expect(withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.create({ data: { organizationId: f.org, invoiceId: f.invoice.id, submissionId: f.submitted.submissionId,
      invoiceVersion: f.submitted.version, idempotencyKey: randomUUID(), requestFingerprint: "a".repeat(64), reason: "No journal or source audit must fail", createdBy: f.account.id } }))).rejects.toThrow(/atomically|audit/iu);
    const result = await recognizeSupplierInvoice(f.ctx, f.command, { db });
    const link = await withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionLine.findFirstOrThrow({ where: { recognitionId: result.recognitionId } }));
    for (const mutate of [
      () => withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.update({ where: { id: result.recognitionId }, data: { reason: "Rewrite the original reason" } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoiceRecognition.delete({ where: { id: result.recognitionId } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionLine.update({ where: { id: link.id }, data: { sourceOccurredAt: new Date() } })),
      () => withTenant(db, f.org, tx => tx.supplierInvoiceRecognitionLine.delete({ where: { id: link.id } }))
    ]) await expect(mutate()).rejects.toThrow(/immutable|append|modif|delet/iu);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(2);
  });
  it("recognizes all 500 actual cent-sized cost lines without truncation or physical money", async () => {
    const f = await invoiceRecognitionFixture({ companyLines: 500 }), result = await recognizeSupplierInvoice(f.ctx, f.command, { db });
    expect(result.transactionIds).toHaveLength(500);
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoiceRecognitionLine.count()).toBe(500); expect(await tx.financialTransaction.count()).toBe(500); expect(await tx.posting.count()).toBe(1000);
      expect((await new SupplierPayableRepository(tx, f.org).outstanding({ supplierId: f.supplier.id, invoiceId: f.invoice.id, currency: "MAD" })).toJSON().amount).toBe("5.00");
      expect(await tx.ledgerAccount.count({ where: { accountType: { in: ["ASSET", "ASSET_LOCATION", "STAFF_WALLET"] } } })).toBe(0);
    });
  });
  it.each([false, true])("executes organization invoice automation once for company or mixed lines without inventing approvals, expenses or money (%s)", async mixed => {
    const f = await invoiceAutomationFixture({}, true, mixed);
    await expect(previewAutomation(f.actor, { ruleId: f.config.id, eventId: f.event.id }, { db })).resolves.toMatchObject({ matched: true, plans: [{ type: "create_approval_request" }] });
    const admissions = await Promise.all(Array.from({ length: 4 }, () => enqueueAutomationEvent(f.org, f.event.id, { db })));
    expect(admissions.every(ids => ids.length === 1 && ids[0] === admissions[0][0])).toBe(true);
    const runId = admissions[0][0];
    expect(await consumeAutomationReference({ organizationId: f.org, outboxEventId: f.event.id }, "SupplierInvoiceSubmitted", db)).toBeDefined();
    expect(await executeAutomationRun(f.org, runId, { db })).toBe("SUCCEEDED");
    const approval = await getApproval({ organizationId: f.org, accountId: f.account.id, authContext: f.actor.authContext }, f.submitted.approvalId!, { db });
    await decideApproval({ organizationId: f.org, accountId: f.account.id, authContext: f.actor.authContext },
      { id: approval.id, stageId: approval.stageId, decision: "REJECTED", reason: "Reject this actual source for retained automation replay" }, { db });
    expect(await enqueueAutomationEvent(f.org, f.event.id, { db })).toEqual([runId]);
    expect(await replayAutomation(f.actor, { runId, reason: "Retain the original completed source outcome" }, { db })).toBe("SUCCEEDED");
    const model = await automationAdmin(f.actor, undefined, { db });
    expect(model.runs.find(run => run.id === runId)).toMatchObject({ propertyId: null, status: "SUCCEEDED", outputs: [{ producedIds: [f.submitted.approvalId] }] });
    expect(model.sources.some(source => source.id === f.event.id)).toBe(true);
    await withTenant(db, f.org, async tx => {
      const run = await tx.automationRun.findUniqueOrThrow({ where: { id: runId } });
      expect(run.propertyId).toBeNull(); expect(run.inputs).toMatchObject({ fields: { invoice: { status: "PENDING_APPROVAL" } } });
      expect(await tx.automationAttempt.count({ where: { runId } })).toBe(1);
      expect(await tx.approvalRequest.count()).toBe(1); expect(await tx.expense.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
    });
  });
  it("denies organization invoice automation before private key admission and false predicate inference after current authority revocation", async () => {
    const f = await invoiceAutomationFixture({ idempotency_key: "invoice:{{invoice.amount}}:{{invoice.invoice_number}}", conditions: { path: "invoice.amount", op: "=", value: "0.00" } });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date("2020-01-01") } }));
    await expect(previewAutomation(f.actor, { ruleId: f.config.id, eventId: f.event.id }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
    const [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    const run = await withTenant(db, f.org, tx => tx.automationRun.findUniqueOrThrow({ where: { id: runId } }));
    expect(run).toMatchObject({ status: "FAILED", errorCode: "automation_forbidden", inputs: { eventId: f.event.id, configRuleId: f.config.id, version: 1 } });
    expect(run.eventKey).toBe(`forbidden:${f.event.id}`); expect(JSON.stringify(run.inputs)).not.toContain("2400");
    const model = await automationAdmin(f.actor, undefined, { db });
    expect(model.sources.some(source => source.id === f.event.id)).toBe(false);
    expect(JSON.stringify(model.runs)).not.toContain(f.draft.invoiceNumber);
    await expect(replayAutomation(f.actor, { runId, reason: "A stale caller cannot replay denied financial source" }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
  });
  it("refuses to create an approval through organization invoice automation when the frozen policy required none", async () => {
    const f = await invoiceAutomationFixture({}, false);
    await expect(previewAutomation(f.actor, { ruleId: f.config.id, eventId: f.event.id }, { db })).rejects.toThrow("automation_invoice_approval_not_required");
    const [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    expect(await executeAutomationRun(f.org, runId, { db })).toBe("RETRY");
    expect(await executeAutomationRun(f.org, runId, { db, now: new Date(Date.now() + 3000) })).toBe("FAILED");
    await withTenant(db, f.org, async tx => { expect(await tx.approvalRequest.count()).toBe(0); expect(await tx.expense.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("protects organization invoice automation preview, history and replay from narrowed caller source grants", async () => {
    const f = await invoiceAutomationFixture(), [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    for (const permission of ["supplier:view", "supplier_invoice:view", "financial_transaction:view", "config_rule:configure"]) {
      const actor = { ...f.actor, authContext: { ...f.actor.authContext, permissions: new Set([...f.actor.authContext.permissions].filter(key => key !== permission)),
        assignments: f.actor.authContext.assignments?.map(assignment => ({ ...assignment, permissions: new Set([...assignment.permissions].filter(key => key !== permission)) })) } };
      await expect(previewAutomation(actor, { ruleId: f.config.id, eventId: f.event.id }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
      await expect(replayAutomation(actor, { runId, reason: "Caller restrictions remain narrower than stored source authority" }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
      const model = await automationAdmin(actor, undefined, { db });
      expect(model.sources.some(source => source.id === f.event.id)).toBe(false);
      expect(JSON.stringify(model.runs)).not.toContain(f.draft.invoiceNumber);
    }
    const records = { ...f.actor, authContext: { ...f.actor.authContext, assignments: f.actor.authContext.assignments?.map(assignment =>
      assignment.permissions.has("financial_transaction:view") ? { ...assignment, scope: { organizationId: f.org, scopeType: "financial_record" as const, scopeId: f.invoice.id } } : assignment) } };
    await expect(previewAutomation(records, { ruleId: f.config.id, eventId: f.event.id }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
  });
  it("rolls back organization invoice automation action and completion audits after current finance authority expires during the actual run-row write wait", async () => {
    const f = await invoiceAutomationFixture(), [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM automation_run WHERE organization_id=${f.org}::uuid AND id=${runId}::uuid FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid; locked(); await gate;
    });
    await ready;
    const running = executeAutomationRun(f.org, runId, { db });
    try {
      await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date() } }));
    } finally { release(); await holder; }
    expect(await running).toBe("FAILED");
    await withTenant(db, f.org, async tx => {
      expect(await tx.auditLog.count({ where: { action: { in: ["automation.action.executed", "automation.run.completed"] } } })).toBe(0);
      expect(await tx.automationAttempt.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: "FAILED", errorCode: "automation_forbidden", outputs: [] });
      expect(await tx.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ outputs: [], inputs: { eventId: f.event.id, configRuleId: f.config.id, version: 1 } });
      expect(await tx.approvalRequest.count()).toBe(1); expect(await tx.expense.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
    });
  });
  it("protects canonical organization invoice automation events, tenant references and frozen inputs at the database and execution boundaries", async () => {
    const f = await invoiceAutomationFixture(), [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    const other = await invoiceAutomationFixture();
    for (const data of [{ type: "TaskCreated" }, { payload: { invoiceId: other.invoice.id, submissionId: f.submitted.submissionId } },
      { occurredAt: new Date("2020-01-01") }, { idempotencyKey: randomUUID() }]) {
      await expect(withTenant(db, f.org, tx => tx.outboxEvent.update({ where: { id: f.event.id }, data }))).rejects.toThrow(/immutable/iu);
    }
    await expect(withTenant(db, f.org, tx => tx.outboxEvent.delete({ where: { id: f.event.id } }))).rejects.toThrow(/immutable/iu);
    await expect(withTenant(db, f.org, tx => new AutomationRepository(tx, f.org).context(f.event.id, f.property.id))).rejects.toThrow("automation_source_missing");
    await expect(withTenant(db, f.org, tx => tx.outboxEvent.create({ data: { organizationId: f.org, type: "SupplierInvoiceSubmitted", payload: {
      invoiceId: other.invoice.id, submissionId: other.submitted.submissionId }, idempotencyKey: randomUUID() } }))).rejects.toThrow(/canonical/iu);
    await expect(withTenant(db, f.org, tx => tx.automationRun.create({ data: { organizationId: f.org, configRuleId: f.config.id, ruleKey: "automation.rule.actual_invoice",
      actorId: f.account.id, eventId: other.event.id, propertyId: null, eventKey: randomUUID(), inputs: {} } }))).rejects.toThrow(/tenant/iu);
    await expect(withTenant(db, f.org, tx => tx.automationRun.create({ data: { organizationId: f.org, configRuleId: f.config.id, ruleKey: "automation.rule.actual_invoice",
      actorId: f.account.id, eventId: f.event.id, propertyId: null, eventKey: f.event.idempotencyKey, inputs: {} } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, async tx => {
      const unrelated = await tx.outboxEvent.create({ data: { organizationId: f.org, type: "TaskCreated", payload: { propertyId: f.property.id }, idempotencyKey: randomUUID() } });
      return tx.automationRun.create({ data: { organizationId: f.org, configRuleId: f.config.id, ruleKey: "automation.rule.actual_invoice", actorId: f.account.id,
        eventId: unrelated.id, propertyId: null, eventKey: randomUUID(), inputs: {} } });
    })).rejects.toThrow(/actual invoice event/iu);
    await withTenant(db, f.org, async tx => {
      const delivered = await tx.outboxEvent.update({ where: { id: f.event.id }, data: { status: "PROCESSED", attemptCount: { increment: 1 }, processedAt: new Date() } });
      expect(delivered).toMatchObject({ payload: f.event.payload, type: f.event.type, idempotencyKey: f.event.idempotencyKey, occurredAt: f.event.occurredAt });
    });
    await withTenant(db, f.org, async tx => {
      const run = await tx.automationRun.findUniqueOrThrow({ where: { id: runId } });
      const source = z.object({ fields: z.record(z.string(), z.unknown()), configs: z.record(z.string(), z.unknown()) }).passthrough().parse(run.inputs);
      source.fields.invoice = { ...(source.fields.invoice as Record<string, unknown>), amount: "0.01" };
      await tx.automationRun.update({ where: { id: runId }, data: { inputs: source as Prisma.InputJsonObject } });
    });
    expect(await executeAutomationRun(f.org, runId, { db })).toBe("RETRY");
    await withTenant(db, f.org, async tx => {
      expect(await tx.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ errorCode: "automation_source_snapshot_mismatch", outputs: [] });
      expect(await tx.auditLog.count({ where: { action: "automation.action.executed" } })).toBe(0);
    });
  });
  it("uses actual propertyless requested and decided invoice approval events in organization invoice automation notifications", async () => {
    const f = await invoiceAutomationFixture({ event: "ApprovalRequested" });
    const requested = await withTenant(db, f.org, tx => tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: {
      organizationId: f.org, idempotencyKey: `approval:${f.submitted.approvalId}:ApprovalRequested` } } }));
    const [requestedRun] = await enqueueAutomationEvent(f.org, requested.id, { db });
    expect(await executeAutomationRun(f.org, requestedRun, { db })).toBe("SUCCEEDED");
    await saveAutomationRule(f.actor, { key: "actual_invoice_decided", lifecycle: "ACTIVE", effectiveFrom: new Date("2020-01-01"),
      reason: "Actual invoice decision notification automation", rule: { name: { en: "Notify invoice submitter", fr: "Notifier le demandeur" }, event: "ApprovalDecided", enabled: true,
        conditions: { all: [] }, actions: [{ key: "notify", type: "notify", kind: "approval_decided", target: "approval.id", recipient: "invoice.submitted_by" }],
        retry: { max_attempts: 2, delay_seconds: 1 } } }, { db });
    const actor = { organizationId: f.org, accountId: f.account.id, authContext: f.actor.authContext };
    const approval = await getApproval(actor, f.submitted.approvalId!, { db });
    await decideApproval(actor, { id: approval.id, stageId: approval.stageId, decision: "APPROVED", reason: "Actual company invoice review is complete" }, { db });
    const decided = await withTenant(db, f.org, tx => tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: {
      organizationId: f.org, idempotencyKey: `approval:${f.submitted.approvalId}:ApprovalDecided` } } }));
    const context = await withTenant(db, f.org, tx => new AutomationRepository(tx, f.org).context(decided.id));
    expect(context.property).toBeNull(); expect(context).not.toHaveProperty("expense");
    expect(context.evaluation.fields).toMatchObject({ invoice: { id: f.invoice.id, status: "APPROVED" }, approval: { id: approval.id, status: "APPROVED" } });
    const [decidedRun] = await enqueueAutomationEvent(f.org, decided.id, { db });
    expect(await executeAutomationRun(f.org, decidedRun, { db })).toBe("SUCCEEDED");
    await withTenant(db, f.org, async tx => {
      expect(await tx.outboxEvent.count({ where: { idempotencyKey: `${decidedRun}:notify`, type: "notification.requested" } })).toBe(1);
      expect(await tx.approvalRequest.count()).toBe(1); expect(await tx.expense.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
    });
  });
  it("requires an independent organization financial grant for a finance-config predicate in organization invoice automation", async () => {
    const f = await invoiceAutomationFixture({ conditions: { path: "invoice.currency", op: "=", value: { config: "finance.accounting_periods", path: "timezone" } } }, true, false, true);
    const [completedRun] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    expect(await executeAutomationRun(f.org, completedRun, { db })).toBe("SKIPPED");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { scopeType: "property", scopeId: f.property.id } }));
    const actor = { ...f.actor, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
    await expect(replayAutomation(actor, { runId: completedRun, reason: "A completed finance-config predicate remains private after organization rights are removed" }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
    await expect(previewAutomation(actor, { ruleId: f.config.id, eventId: f.event.id }, { db })).rejects.toBeInstanceOf(AutomationAccessError);
    const [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db });
    expect(await withTenant(db, f.org, tx => tx.automationRun.findUniqueOrThrow({ where: { id: runId } }))).toMatchObject({ status: "FAILED", errorCode: "automation_forbidden",
      inputs: { eventId: f.event.id, configRuleId: f.config.id, version: 1 } });
  });
  it("hides completed predicate outcomes and source references in organization invoice automation history after finance revocation", async () => {
    const f = await invoiceAutomationFixture({ conditions: { path: "invoice.amount", op: "=", value: "0.00" } });
    const [runId] = await enqueueAutomationEvent(f.org, f.event.id, { db }); expect(await executeAutomationRun(f.org, runId, { db })).toBe("SKIPPED");
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { validTo: new Date("2020-01-01") } }));
    const model = await automationAdmin(f.actor, undefined, { db }), row = model.runs.find(run => run.id === runId);
    expect(row).toBeDefined();
    for (const key of ["status", "eventId", "attempts", "attemptCount", "completedAt", "errorCode"]) expect(row).not.toHaveProperty(key);
    expect(JSON.stringify(model.runs)).not.toContain(f.draft.invoiceNumber);
    expect(JSON.stringify(model.runs)).not.toContain(f.event.id);
  });
  it("freezes and retries one actual company invoice submission without recognizing or paying it", async () => {
    const f = await invoicePolicyFixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    const current = await getSupplierInvoice(f.ctx, invoice.id, {}, { db }), notes = Object.fromEntries(current.lines.map(line => [line.id, "Actual company invoice line review"]));
    const command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(), reason: "Actual invoice source submission", lineNotes: notes };
    const results = await Promise.all(Array.from({ length: 4 }, () => submitSupplierInvoice(f.ctx, command, { db })));
    expect(results.filter(result => !result.idempotent)).toHaveLength(1); expect(new Set(results.map(result => result.submissionId)).size).toBe(1);
    expect(results[0]).toMatchObject({ state: "APPROVED", version: 2, approvalId: null });
    await expect(submitSupplierInvoice(f.ctx, { ...command, reason: "A changed request cannot reuse the original intent" }, { db })).rejects.toBeInstanceOf(SupplierInvoiceConflictError);
    const original = await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoiceSubmission.count()).toBe(1); expect(await tx.approvalRequest.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
      expect(await tx.expense.count()).toBe(0); expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.submitted" } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { type: "SupplierInvoiceSubmitted" } })).toBe(1);
      return tx.supplierInvoiceSubmission.findUniqueOrThrow({ where: { id: results[0].submissionId } });
    });
    await expect(withTenant(db, f.org, tx => tx.supplierInvoiceSubmission.update({ where: { id: original.id }, data: { reason: "An immutable submission cannot be rewritten" } }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.supplierInvoiceSubmission.findUniqueOrThrow({ where: { id: original.id } }))).toEqual(original);
  });
  it("loads the actual propertyless invoice event into organization automation without inventing an expense or property", async () => {
    const f = await invoicePolicyFixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const source = await submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Actual organization invoice automation source", lineNotes: { [draft.lines[0].id]: "Actual company invoice cost review context" } }, { db });
    const event = await withTenant(db, f.org, tx => tx.outboxEvent.findUniqueOrThrow({ where: { organizationId_idempotencyKey: {
      organizationId: f.org, idempotencyKey: `supplier-invoice:${source.submissionId}:SupplierInvoiceSubmitted` } } }));
    const context = await withTenant(db, f.org, tx => new AutomationRepository(tx, f.org).context(event.id));
    expect(context.property).toBeNull(); expect(context).not.toHaveProperty("expense");
    expect(context.scopes).toEqual([{ scopeType: "organization", scopeId: null }]);
    expect(context.evaluation.fields).not.toHaveProperty("property");
    expect(context.evaluation.fields).toMatchObject({ organization: { id: f.org }, invoice: { id: invoice.id, submission_id: source.submissionId,
      revision_id: draft.revisionId, amount: "2400.00", currency: "MAD", status: "APPROVED" } });
    await withTenant(db, f.org, async tx => { expect(await tx.expense.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("uses the shared financial approval engine for a real propertyless invoice and records a reasoned decision atomically", async () => {
    const f = await invoicePolicyFixture();
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
      reason: "Configured company invoice finance review", value: { thresholds: [{ key: "finance_review", requires_approval_from: ["finance"] }],
        routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } }));
    const invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db }), current = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const submitted = await submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Actual company invoice requires finance review", lineNotes: Object.fromEntries(current.lines.map(line => [line.id, "Review this actual company line alone"])) }, { db });
    expect(submitted.state).toBe("PENDING_APPROVAL"); expect(submitted.approvalId).toBeTruthy();
    const actor = { organizationId: f.org, accountId: f.account.id, authContext: f.ctx.authContext };
    const approval = await getApproval(actor, submitted.approvalId!, { db });
    expect(approval).toMatchObject({ propertyName: null, details: "Review this actual company line alone", financial: { amount: "2400.00" }, canApprove: true });
    const decision = { id: approval.id, stageId: approval.stageId, decision: "APPROVED", reason: "Finance approves the actual company invoice" };
    await decideApproval(actor, decision, { db }); await decideApproval(actor, decision, { db });
    await withTenant(db, f.org, async tx => {
      expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } }))).toMatchObject({ state: "APPROVED", version: 2 });
      expect((await tx.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).state).toBe("APPROVED");
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.approval_stage_decided" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.approved" } })).toBe(1); expect(await tx.financialTransaction.count()).toBe(0);
    });
  });
  it("creates a new draft revision after rejection while preserving the original submission and approval history", async () => {
    const f = await invoicePolicyFixture(), creation = input(f.supplier.id);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
      reason: "Configured source rejection review", value: { thresholds: [{ key: "finance_review", requires_approval_from: ["finance"] }],
        routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } }));
    const invoice = await createSupplierInvoice(f.ctx, creation, { db }), draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "First actual invoice source review", lineNotes: Object.fromEntries(draft.lines.map(line => [line.id, "Actual rejected cost line review"])) };
    const submitted = await submitSupplierInvoice(f.ctx, command, { db }), actor = { organizationId: f.org, accountId: f.account.id, authContext: f.ctx.authContext };
    const review = await getApproval(actor, submitted.approvalId!, { db });
    await decideApproval(actor, { id: review.id, stageId: review.stageId, decision: "REJECTED", reason: "The actual cost requires a corrected source" }, { db });
    const history = await withTenant(db, f.org, async tx => ({ source: await tx.supplierInvoiceSubmission.findUniqueOrThrow({ where: { id: submitted.submissionId } }),
      approval: await tx.approvalRequest.findUniqueOrThrow({ where: { id: review.id }, include: { financialStages: true } }) }));
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).canEdit).toBe(true);
    await updateSupplierInvoice(f.ctx, { ...update(creation, invoice.id, 2), purpose: "Corrected actual supplier source", lines: [{ category: "maintenance", amount: "2000.00" }] }, { db });
    const revised = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    expect(revised).toMatchObject({ state: "DRAFT", version: 3, amount: "2000.00", canEdit: true }); expect(revised.revisionId).not.toBe(draft.revisionId);
    const second = await submitSupplierInvoice(f.ctx, { ...command, expectedVersion: 3, idempotencyKey: randomUUID(),
      reason: "Submit the corrected immutable invoice revision", lineNotes: Object.fromEntries(revised.lines.map(line => [line.id, "Corrected actual cost line review"])) }, { db });
    expect(second.submissionId).not.toBe(submitted.submissionId); expect(second.state).toBe("PENDING_APPROVAL");
    await expect(submitSupplierInvoice(f.ctx, command, { db })).resolves.toMatchObject({ submissionId: submitted.submissionId, state: "REJECTED", idempotent: true });
    await withTenant(db, f.org, async tx => {
      expect(await tx.supplierInvoiceSubmission.findUniqueOrThrow({ where: { id: submitted.submissionId } })).toEqual(history.source);
      expect(await tx.approvalRequest.findUniqueOrThrow({ where: { id: review.id }, include: { financialStages: true } })).toEqual(history.approval);
      expect(await tx.supplierInvoiceSubmission.count()).toBe(2); expect(await tx.financialTransaction.count()).toBe(0);
    });
  });
  it("revalidates configured currency precision before freezing an existing draft submission", async () => {
    const f = await invoicePolicyFixture();
    await admin.currency.upsert({ where: { code: "XTS" }, update: { minorUnit: 2 }, create: { code: "XTS", name: "Dedicated precision acceptance", minorUnit: 2 } });
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), currency: "XTS", lines: [{ category: "office", amount: "10.01" }] }, { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    await admin.currency.update({ where: { code: "XTS" }, data: { minorUnit: 0 } });
    await expect(submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Current currency precision must be retained", lineNotes: Object.fromEntries(draft.lines.map(line => [line.id, "Actual cost requires current currency precision"])) }, { db })).rejects.toThrow(/currency|precision/iu);
    await withTenant(db, f.org, async tx => { expect(await tx.supplierInvoiceSubmission.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
      expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).state).toBe("DRAFT"); });
  });
  it("keeps each owner's review private and ordered and hides another reviewer's rejection from cancelled stages", async () => {
    const f = await invoicePolicyFixture(), reviewers = await invoiceOwnerReviewers(f);
    const creation = { ...input(f.supplier.id), purpose: "Private whole invoice header for company finance only", lines: [
      { propertyId: f.property.id, category: "maintenance", amount: "1200.50" }, { category: "office", amount: "9000.00" }] };
    const invoice = await createSupplierInvoice(f.ctx, creation, { db }), draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const result = await submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Private complete invoice submission explanation", lineNotes: { [draft.lines[0].id]: "Actual shared villa maintenance line", [draft.lines[1].id]: "Confidential unrelated company cost" } }, { db });
    const manager = { organizationId: f.org, accountId: f.account.id, authContext: f.ctx.authContext };
    const first = await getApproval(manager, result.approvalId!, { db });
    const ownerStages = await withTenant(db, f.org, tx => tx.approvalStage.findMany({ where: { organizationId: f.org, approvalId: result.approvalId!, kind: "owner" }, orderBy: { position: "asc" } }));
    expect(ownerStages).toHaveLength(2);
    for (const reviewer of reviewers) {
      const own = await getApproval(reviewer.actor, first.id, { db });
      expect(own).toMatchObject({ details: "Actual shared villa maintenance line", financial: { amount: "600.25", currency: "MAD" }, canApprove: false, canReject: false });
      expect(JSON.stringify(own)).not.toMatch(/9000|Private whole|Confidential unrelated|Private complete/u);
      await expect(getSupplierInvoice({ organizationId: f.org, actorId: reviewer.account.id, authContext: reviewer.actor.authContext }, invoice.id, {}, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
      const foreign = ownerStages.find(stage => stage.ownerId !== reviewer.ownerId)!;
      expect(own.history.map(stage => stage.id)).toEqual([ownerStages.find(stage => stage.ownerId === reviewer.ownerId)!.id]);
      await expect(getApproval(reviewer.actor, first.id, { db, stageId: foreign.id })).rejects.toBeInstanceOf(ApprovalAccessError);
      await expect(decideApproval(reviewer.actor, { id: first.id, stageId: foreign.id, decision: "APPROVED", reason: "Cannot decide another owner's actual cost" }, { db })).rejects.toBeInstanceOf(ApprovalAccessError);
    }
    await decideApproval(manager, { id: first.id, stageId: first.stageId, decision: "APPROVED", reason: "Manager approves only this configured step" }, { db });
    const selected = reviewers.find(reviewer => reviewer.ownerId === ownerStages[0].ownerId)!, other = reviewers.find(reviewer => reviewer !== selected)!;
    const ownerReview = await getApproval(selected.actor, first.id, { db }); expect(ownerReview.canReject).toBe(true);
    const rejecting = { id: first.id, stageId: ownerReview.stageId, decision: "REJECTED", reason: "Private first-owner rejection details" };
    await decideApproval(selected.actor, rejecting, { db }); await decideApproval(selected.actor, rejecting, { db });
    const cancelled = await getApproval(other.actor, first.id, { db });
    expect(cancelled).toMatchObject({ state: "CANCELLED", decisionReason: null, financial: { amount: "600.25" }, canApprove: false });
    expect(JSON.stringify(cancelled)).not.toContain(rejecting.reason);
    await expect(decideApproval(other.actor, { id: first.id, stageId: cancelled.stageId, decision: "APPROVED", reason: "Cancelled review cannot be approved" }, { db })).rejects.toBeInstanceOf(ApprovalConflictError);
    await withTenant(db, f.org, async tx => { expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).state).toBe("REJECTED");
      expect(await tx.approvalStage.count({ where: { state: "CANCELLED" } })).toBe(2); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("retains configured zero-cent owner review steps for an indivisible one-cent invoice line", async () => {
    const f = await invoicePolicyFixture(), reviewers = await invoiceOwnerReviewers(f);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: [{ propertyId: f.property.id, category: "maintenance", amount: "0.01" }] }, { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const result = await submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Every configured owner review is retained", lineNotes: { [draft.lines[0].id]: "Actual indivisible one-cent invoice cost" } }, { db });
    const stages = await withTenant(db, f.org, tx => tx.approvalStage.findMany({ where: { approvalId: result.approvalId! }, orderBy: { position: "asc" } }));
    expect(stages).toHaveLength(4); expect(stages.filter(stage => stage.kind === "owner").map(stage => stage.amount.toFixed(2)).sort()).toEqual(["0.00", "0.01"]);
    const manager = { organizationId: f.org, accountId: f.account.id, authContext: f.ctx.authContext };
    for (const stage of stages) {
      const actor = stage.kind === "owner" ? reviewers.find(reviewer => reviewer.ownerId === stage.ownerId)!.actor : manager;
      const review = await getApproval(actor, result.approvalId!, { db }); expect(review).toMatchObject({ stageId: stage.id, canApprove: true });
      await decideApproval(actor, { id: review.id, stageId: stage.id, decision: "APPROVED", reason: "Approve this configured exact owner slice" }, { db });
    }
    expect((await getSupplierInvoice(f.ctx, invoice.id, {}, { db })).state).toBe("APPROVED");
  });
  it("pages every owned review across 51 actual invoice lines and rejects another owner's stage cursor", async () => {
    const f = await invoicePolicyFixture(), reviewers = await invoiceOwnerReviewers(f);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: Array.from({ length: 51 }, () => ({ propertyId: f.property.id, category: "maintenance", amount: "1.01" })) }, { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const result = await submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Review all actual cost lines without cross-owner history", lineNotes: Object.fromEntries(draft.lines.map((line, index) => [line.id, `Actual owner review note for line ${index + 1}`])) }, { db });
    const otherStage = await withTenant(db, f.org, tx => tx.approvalStage.findFirstOrThrow({ where: { approvalId: result.approvalId!, ownerId: reviewers[1].ownerId, kind: "owner" } }));
    const first = await getApproval(reviewers[0].actor, result.approvalId!, { db }); expect(first.history).toHaveLength(50); expect(first.historyNext).toBeTruthy();
    const next = await getApproval(reviewers[0].actor, result.approvalId!, { db, afterStageId: first.historyNext }); expect(next.history).toHaveLength(1); expect(next.historyNext).toBeUndefined();
    expect(new Set([...first.history, ...next.history].map(stage => stage.id)).size).toBe(51);
    const selected = await getApproval(reviewers[0].actor, result.approvalId!, { db, stageId: next.history[0].id });
    expect(selected).toMatchObject({ details: "Actual owner review note for line 51", stageId: next.history[0].id, canApprove: false });
    await expect(getApproval(reviewers[0].actor, result.approvalId!, { db, afterStageId: otherStage.id })).rejects.toBeInstanceOf(ApprovalAccessError);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });
  it("delivers mandatory emergency receipts and reads only the addressed owner's frozen line allocation", async () => {
    const f = await invoicePolicyFixture(), reviewers = await invoiceOwnerReviewers(f, true);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), purpose: "Private complete emergency invoice header", lines: [
      { propertyId: f.property.id, category: "maintenance", amount: "1200.50" }, { category: "office", amount: "9000.00" }] }, { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: true, idempotencyKey: randomUUID(),
      reason: "Actual configured emergency submission", lineNotes: { [draft.lines[0].id]: "Emergency villa cost addressed to its owners", [draft.lines[1].id]: "Confidential emergency company cost" } };
    await expect(submitSupplierInvoice(f.ctx, command, { db })).resolves.toMatchObject({ state: "APPROVED", approvalId: null });
    await expect(submitSupplierInvoice(f.ctx, command, { db })).resolves.toMatchObject({ idempotent: true });
    const events = await withTenant(db, f.org, async tx => { expect(await tx.notification.count({ where: { kind: "supplier_invoice_emergency" } })).toBe(2);
      expect(await tx.approvalRequest.count()).toBe(0); expect(await tx.financialTransaction.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.emergency_owner_notified" } })).toBe(1);
      return tx.outboxEvent.findMany({ where: { type: "notification.requested", idempotencyKey: { startsWith: "supplier-invoice:" } } }); });
    for (const reviewer of reviewers) {
      const inbox = { ...reviewer.actor, authContext: ownNotificationContext(reviewer.actor.authContext, reviewer.account.id) };
      const notice = (await getNotificationPage(inbox, {}, { db })).items.find(item => item.kind === "supplier_invoice_emergency")!; expect(notice.available).toBe(true);
      const destination = await openNotification(inbox, notice.id, "fr", { db });
      const eventId = destination.split("/").at(-1)!;
      const context = { organizationId: f.org, actorId: reviewer.account.id, authContext: reviewer.actor.authContext };
      const data = await getSupplierInvoiceNotice(context, eventId, { db });
      expect(data).toEqual({ id: eventId, propertyName: f.property.name, purpose: "Emergency villa cost addressed to its owners", category: "maintenance",
        amount: "600.25", ownerAmount: "600.25", currency: "MAD", occurredOn: "2026-10-28" });
      const otherEvent = events.find(event => event.id !== eventId)!;
      await expect(getSupplierInvoiceNotice(context, otherEvent.id, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: reviewer.grant.id }, data: { validTo: new Date() } }));
      await expect(getSupplierInvoiceNotice(context, eventId, { db })).rejects.toBeInstanceOf(SupplierInvoiceAccessError);
      await expect(openNotification(inbox, notice.id, "fr", { db })).rejects.toBeInstanceOf(NotificationAccessError);
    }
    await withTenant(db, f.org, async tx => { for (const event of events) await new NotificationRepository(tx, f.org).deliver({ ...event, status: "PENDING" });
      expect(await tx.notification.count({ where: { kind: "supplier_invoice_emergency" } })).toBe(2); });
  });
  it("rolls back invoice submission when a required emergency notice has no durable receipt", async () => {
    const f = await invoicePolicyFixture(); await invoiceOwnerReviewers(f, true);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: [{ propertyId: f.property.id, category: "maintenance", amount: "1200.50" }] }, { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: true, idempotencyKey: randomUUID(),
      reason: "Required invoice notice must exist atomically", lineNotes: { [draft.lines[0].id]: "Actual emergency cost requires both owner notices" } };
    const fault = vi.spyOn(NotificationRepository.prototype, "publishInvoiceEmergencyNotices").mockResolvedValueOnce({ count: 2 });
    try { await expect(submitSupplierInvoice(f.ctx, command, { db })).rejects.toThrow(/receipt|notice/iu); } finally { fault.mockRestore(); }
    await withTenant(db, f.org, async tx => { expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } }))).toMatchObject({ state: "DRAFT", version: 0 });
      expect(await tx.supplierInvoiceSubmission.count()).toBe(0); expect(await tx.notification.count()).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: "SupplierInvoiceSubmitted" } })).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.submitted" } })).toBe(0); });
    await expect(submitSupplierInvoice(f.ctx, command, { db })).resolves.toMatchObject({ state: "APPROVED", idempotent: false });
  });
  it("rolls back a newly frozen invoice if a required review audience loses authority during the actual source event write", async () => {
    const f = await invoicePolicyFixture(), reviewers = await invoiceOwnerReviewers(f);
    const invoice = await createSupplierInvoice(f.ctx, { ...input(f.supplier.id), lines: [{ propertyId: f.property.id, category: "maintenance", amount: "1200.50" }] }, { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db }), command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "A configured invoice review must remain possible", lineNotes: { [draft.lines[0].id]: "Actual owner cost needs current reviewers" } };
    const original = Object.getOwnPropertyDescriptor(SupplierInvoiceRepository.prototype, "event")?.value as SupplierInvoiceRepository["event"];
    if (typeof original !== "function") throw Error("Actual invoice business event writer required");
    const expire = vi.spyOn(SupplierInvoiceRepository.prototype, "event").mockImplementation(async function (this: SupplierInvoiceRepository, ...args) {
      const result = await original.call(this, ...args);
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: reviewers[0].grant.id }, data: { validTo: new Date() } }));
      return result;
    });
    try { await expect(submitSupplierInvoice(f.ctx, command, { db })).rejects.toThrow(/review|recipient|approval/iu); } finally { expire.mockRestore(); }
    await withTenant(db, f.org, async tx => { expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } }))).toMatchObject({ state: "DRAFT", version: 0 });
      expect(await tx.supplierInvoiceSubmission.count()).toBe(0); expect(await tx.approvalRequest.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.submitted" } })).toBe(0); expect(await tx.financialTransaction.count()).toBe(0); });
  });
  it("rechecks financial source authority after a real invoice-header write wait and rolls back the frozen submission", async () => {
    const f = await invoicePolicyFixture(), invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db });
    const draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db }), command = { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Actual invoice wait must retain source authority", lineNotes: { [draft.lines[0].id]: "Review actual source authority after the write wait" } };
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM supplier_invoice WHERE organization_id=${f.org}::uuid AND id=${invoice.id}::uuid FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid; locked(); await gate;
    });
    await ready;
    const submitting = submitSupplierInvoice(f.ctx, command, { db }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.financialGrant.id }, data: { archivedAt: new Date() } }));
    } finally { release(); await holder; }
    const result = await submitting; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(SupplierInvoiceAccessError);
    await withTenant(db, f.org, async tx => { expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } }))).toMatchObject({ state: "DRAFT", version: 0 });
      expect(await tx.supplierInvoiceSubmission.count()).toBe(0); expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.submitted" } })).toBe(0);
      expect(await tx.outboxEvent.count({ where: { type: "SupplierInvoiceSubmitted" } })).toBe(0); });
  });
  it.each(["APPROVED", "REJECTED"] as const)("rolls back an invoice %s decision after stored authority expires during its actual stage-row wait", async decision => {
    const f = await invoicePolicyFixture();
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.approval_thresholds", scopeType: "organization", effectiveFrom: new Date("2020-01-02"),
      reason: "Actual company invoice stage wait review", value: { thresholds: [{ key: "finance_review", requires_approval_from: ["finance"] }],
        routing: { finance: { people: [f.account.personId], roles: [], assigned: false, channels: ["in_app"] } } } }));
    const invoice = await createSupplierInvoice(f.ctx, input(f.supplier.id), { db }), draft = await getSupplierInvoice(f.ctx, invoice.id, {}, { db });
    const result = await submitSupplierInvoice(f.ctx, { id: invoice.id, expectedVersion: 0, occurredOn: "2026-10-28", emergency: false, idempotencyKey: randomUUID(),
      reason: "Actual financial stage wait submission", lineNotes: { [draft.lines[0].id]: "Review this actual company cost line" } }, { db });
    const actor = { organizationId: f.org, accountId: f.account.id, authContext: f.ctx.authContext }, review = await getApproval(actor, result.approvalId!, { db });
    let release!: () => void, locked!: () => void, blocker = 0;
    const ready = new Promise<void>(resolve => locked = resolve), gate = new Promise<void>(resolve => release = resolve);
    const holder = withTenant(admin, f.org, async tx => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM approval_stage WHERE organization_id=${f.org}::uuid AND id=${review.stageId}::uuid FOR UPDATE`);
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; blocker = row.pid; locked(); await gate;
    });
    await ready;
    const deciding = decideApproval(actor, { id: review.id, stageId: review.stageId, decision, reason: "This decision must retain current stage authority" }, { db })
      .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
    try {
      await vi.waitFor(async () => { const [row] = await admin.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${blocker}=ANY(pg_blocking_pids(pid))) AS waiting`); expect(row.waiting).toBe(true); }, { timeout: 10000 });
      await withTenant(admin, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { validTo: new Date() } }));
    } finally { release(); await holder; }
    const decided = await deciding; expect(decided.ok).toBe(false); if (!decided.ok) expect(decided.error).toBeInstanceOf(ApprovalAccessError);
    await withTenant(db, f.org, async tx => { expect((await tx.supplierInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).state).toBe("PENDING_APPROVAL");
      expect((await tx.approvalStage.findUniqueOrThrow({ where: { id: review.stageId } })).state).toBe("PENDING");
      expect(await tx.auditLog.count({ where: { action: "finance.supplier_invoice.approval_stage_decided" } })).toBe(0); expect(await tx.financialTransaction.count()).toBe(0); });
  });
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
