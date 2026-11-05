import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import * as audits from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { PaymentMethodRepository } from "@/modules/finance/infrastructure/payment-method-repository";
import { guestPaymentMethodScopes } from "@/modules/finance/application/guest-deposit-payment-method";
import { inspectGuestDepositReceiptInTransaction, reviewGuestDepositRefund } from "@/modules/finance/application/guest-deposit-service";
import { requestExternalPaymentCapture, executeExternalPaymentCaptureReference, externalPaymentCaptureRequested } from "@/modules/finance/application/external-payment-service";
import { reviewCapturedPayPalAdmission } from "@/modules/finance/application/external-payment-workspace-service";
import { admitCapturedPayPalPayment } from "@/modules/finance/application/native-paypal-admission";
import { prepareExternalPaymentFee } from "@/modules/finance/application/external-payment-fee-service";
import { submitExpense, updateExpenseDraft, createExpenseCorrectionDraft, getExpense } from "@/modules/finance/application/expense-service";
import { AuditRepository } from "@/modules/audit/infrastructure/audit-repository";
import { readExternalPaymentRefundWorkspace, executeExternalPaymentRefundCommand } from "@/modules/finance/application/external-payment-refund-api-service";
import { readExternalPaymentRefundFee } from "@/modules/finance/application/external-payment-refund-fee-service";
import { externalRefundFeePlanSchema, externalRefundViewSchema } from "@/modules/finance/domain/external-payment-refund-workspace";
import { requestExternalPaymentRefund, executeExternalPaymentRefundReference, externalPaymentRefundRequested } from "@/modules/finance/application/external-payment-refund-service";
import { prepareExternalPaymentRefundFee } from "@/modules/finance/application/external-payment-refund-fee-service";
import { reviewExternalPaymentRefundAdmission, admitExternalPaymentRefund } from "@/modules/finance/application/external-payment-refund-admission";
import { postExpense, voidExpense } from "@/modules/finance/application/expense-posting-service";
import { Money } from "@/platform/money/money";
import { ExternalPaymentRefundError } from "@/modules/finance/domain/external-payment-refund-intent";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";

let admin: PrismaClient, db: PrismaClient, control: PrismaClient;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL, target = url ? new URL(url) : null;
  if (!target || !["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned fee-return acceptance database required");
  control = new PrismaClient({ datasourceUrl: url }); const database = "alvillas_automation_refundfee182_" + randomUUID().replaceAll("-", "").slice(0, 16);
  await control.$executeRawUnsafe('CREATE DATABASE "' + database + '"'); const shadow = new URL(url!); shadow.pathname = "/" + database;
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", resolve("prisma/schema.prisma")], { env: { ...process.env, DATABASE_URL: shadow.toString() }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: shadow.toString() }); await provisionIntegrationRole(admin, "alvillas_ops_tests"); const restricted = new URL(shadow); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
  expect(await db.$queryRaw`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  await admin.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "MAD", minorUnit: 2 } });
}, 120000);
afterEach(() => vi.restoreAllMocks()); afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); await control?.$disconnect(); });
const labels = { en: "Original PayPal", fr: "PayPal initial", ar: "باي بال الأصلي" };
const facts = (org: string) => withTenant(db, org, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${org}::uuid ORDER BY kind,id`);
async function fixture(treatment: "OWNER_PAID" | "INCLUDED_IN_COMMISSION" = "OWNER_PAID", returnedFee = "0.01", ownerShares = [10000]) {
  const f = await actualGuestDepositFixture(db, admin, "MAD", 2, "0.07", ownerShares, { "finance.expense_treatment": { default_treatment: treatment }, "finance.approval_thresholds": { thresholds: [] } }),
    merchant = await withTenant(db, f.org, tx => new FinanceRepository(tx, f.org).ensureLedgerAccount({ code: "PAYPAL_MERCHANT_BALANCE", name: "Actual original merchant location", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }));
  await withTenant(db, f.org, async tx => {
    const keys = ["expense:create", "expense:view", "expense:edit", "expense:pay", "expense:void", "financial_transaction:override"], permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })), skipDuplicates: true });
    const rules = new ConfigRuleRepository(tx, f.org);
    await rules.createVersion({ key: "finance.guest_deposits", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { ...f.policy, receipt_account_codes: [...f.policy.receipt_account_codes, merchant.code], refund_account_codes: [...f.policy.refund_account_codes, merchant.code], payment_methods: [...f.policy.payment_methods, { key: "confirmed-paypal", labels }] }, reason: "Explicit original capture and refund fee configuration" });
    await rules.createVersion({ key: "finance.payment_methods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { methods: [{ key: "confirmed-paypal", labels, adapter: "paypal", enabled: true, currencies: ["MAD"], provider_account_code: merchant.code }] }, reason: "Explicit original provider merchant mapping" });
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } }, orderId = "ORDER_" + randomUUID(), input = await withTenant(db, f.org, async tx => {
    const receipt = { ...f.receiptInput, accountId: merchant.id, method: "confirmed-paypal", externalReference: orderId }, prepared = await inspectGuestDepositReceiptInTransaction(ctx, receipt, tx),
      now = await new FinanceRepository(tx, f.org).clock(), catalog = await new PaymentMethodRepository(tx, f.org).catalog({ at: now, currency: "MAD", scopes: await guestPaymentMethodScopes(tx, f.org, f.reservationId, now) });
    return { provider: "paypal" as const, orderId, receipt: { ...receipt, idempotencyKey: randomUUID(), reason: "Retain the original source before its provider fee return", reviewFingerprint: prepared.fingerprint, paymentMethodFingerprint: catalog.identity } };
  });
  const requested = await requestExternalPaymentCapture(ctx, input, { db }), captureEvent = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentCaptureRequested, payload: { path: ["intentId"], equals: requested.id } } })),
    capture = { paymentId: "CAPTURE_" + randomUUID(), capturedAt: new Date().toISOString(), settlement: { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_RECEIVABLE_BREAKDOWN" as const, gross: { amount: "0.07", currency: "MAD" }, fee: { amount: "0.02", currency: "MAD" }, net: { amount: "0.05", currency: "MAD" } } },
    observed = await executeExternalPaymentCaptureReference({ organizationId: f.org, outboxEventId: captureEvent.id }, { db, provider: { lookup: () => Promise.resolve({ state: "CAPTURED" as const, ...capture }), capture: () => Promise.resolve(capture) } }),
    fee = await prepareExternalPaymentFee(ctx, { intentId: requested.id, category: "provider_fee", purpose: "Actual original merchant payment deduction", reason: "Prepare the actual fee through configured expense rules" }, { db }),
    approved = await submitExpense(ctx, { id: fee.id, expectedVersion: fee.version, reason: "Apply the original fee approval rules" }, { db }), review = await reviewCapturedPayPalAdmission(ctx, { id: requested.id }, { db });
  await admitCapturedPayPalPayment(ctx, { intentId: requested.id, reviewFingerprint: review.reviewFingerprint, paymentMethodFingerprint: review.paymentMethodFingerprint,
    reason: "Admit the actual original capture and approved deduction", fee: { expenseId: fee.id, expectedVersion: approved.version, reason: "Post the actual original provider fee with native receipt" } }, { db });
  const refund = { depositId: input.receipt.idempotencyKey, accountId: merchant.id, amount: "0.03", currency: "MAD", method: "confirmed-paypal", externalReference: null, purpose: "Return actual guest funds with verified cost credit" },
    refundReview = await reviewGuestDepositRefund(ctx, refund, { db }), refundInput = { captureId: observed.captureId!, refund: { ...refund, reviewFingerprint: refundReview.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Refund only the reviewed original guest funds" } },
    request = await requestExternalPaymentRefund(ctx, refundInput, { db }), event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentRefundRequested, payload: { path: ["intentId"], equals: request.id } } })), at = new Date().toISOString(),
    evidence = { refundId: "REFUND_" + randomUUID(), captureId: capture.paymentId, requestId: refundInput.refund.idempotencyKey, amount: { amount: "0.03", currency: "MAD" }, state: "COMPLETED" as const, createdAt: at, updatedAt: at, refundedAt: at,
      settlement: { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.03", currency: "MAD" }, fee: { amount: returnedFee, currency: "MAD" }, net: Money.of("0.03", "MAD").subtract(Money.of(returnedFee, "MAD")).toJSON(), totalRefunded: { amount: "0.03", currency: "MAD" } } };
  await executeExternalPaymentRefundReference({ organizationId: f.org, outboxEventId: event.id }, { db, provider: { refund: () => Promise.resolve(evidence), lookupRefund: () => Promise.resolve(evidence) } });
  return { ...f, ctx, input, request, fee, capture, evidence, captureId: observed.captureId!, merchant };
}
describe("verified original provider fee return provenance", () => {
  it("retains original co-owner cents and agreement versions after current ownership and fee treatment change", async () => {
    const f = await fixture("OWNER_PAID", "0.01", [3333, 6667]), original = await withTenant(db, f.org, tx => tx.expenseSubmission.findFirstOrThrow({ where: { organizationId: f.org, expenseId: f.fee.id } }));
    await withTenant(db, f.org, async tx => {
      await tx.propertyOwner.updateMany({ where: { organizationId: f.org, propertyId: f.property.id, archivedAt: null }, data: { shareBps: 5000 } });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
        value: { default_treatment: "INCLUDED_IN_COMMISSION" }, reason: "Current owners and treatment cannot reassign an original captured provider cost" });
    });
    const binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), draft = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } }));
    await submitExpense(f.ctx, { id: draft.id, expectedVersion: draft.version, reason: "Retain original agreement versions and cumulative cents for both owners" }, { db });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db }); await admitExternalPaymentRefund(f.ctx, { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint }, { db });
    const proof = await withTenant(db, f.org, async tx => ({ submission: await tx.expenseSubmission.findFirstOrThrow({ where: { organizationId: f.org, expenseId: draft.id } }), postings: await tx.posting.findMany({ where: { organizationId: f.org, dimensions: { path: ["expense_id"], equals: draft.id }, transaction: { reversesTransactionId: null } } }) }));
    const policies = (value: unknown) => { const parsed = value as { policies: Array<{ ownerId: string; shareBps: number; allocationRule: unknown; approvalRule: unknown; configReferences: unknown }> };
      return parsed.policies.map(({ ownerId, shareBps, allocationRule, approvalRule, configReferences }) => ({ ownerId, shareBps, allocationRule, approvalRule, configReferences })); };
    expect(policies(proof.submission.snapshot)).toEqual(policies(original.snapshot)); expect(policies(proof.submission.snapshot).map(owner => owner.shareBps).sort()).toEqual([3333, 6667]);
    expect(proof.postings.filter(row => row.bucket === "OWNER_EXPENSE").reduce((total, row) => total.add(Money.of(row.amount.toString(), row.currency)), Money.zero("MAD")).toJSON().amount).toBe("0.01");
    expect(proof.postings.filter(row => row.bucket === "ALVILLAS_EXPENSE")).toHaveLength(0);
  });
  it("reads and prepares the exact original fee through the private command boundary and keeps approval in the ordinary expense workflow", async () => {
    const f = await fixture(), before = await facts(f.org), initial = externalRefundFeePlanSchema.parse(await readExternalPaymentRefundWorkspace(f.ctx, { operation: "GET_FEE", input: { intentId: f.request.id } }, { db }));
    expect(initial).toMatchObject({ intentId: f.request.id, bindingId: null, expenseId: null, state: "UNPREPARED", returnedFee: { amount: "0.01", currency: "MAD" }, remainingCost: { amount: "0.01", currency: "MAD" } });
    await executeExternalPaymentRefundCommand(f.ctx, { operation: "PREPARE_FEE", input: { intentId: f.request.id } }, { db });
    const plan = externalRefundFeePlanSchema.parse(await readExternalPaymentRefundWorkspace(f.ctx, { operation: "GET_FEE", input: { intentId: f.request.id } }, { db })); expect(plan.state).toBe("DRAFT"); expect(plan.expenseId).not.toBeNull(); expect(await facts(f.org)).toEqual(before);
    const expense = await getExpense(f.ctx, plan.expenseId!, { db }); expect(expense).toMatchObject({ canSubmit: true, canEditDraft: false, canPost: false, providerRefund: true });
    expect((await withTenant(db, f.org, tx => new AuditRepository(tx, f.org).expenseResources([expense.id]))).get(expense.id)?.occurredAt).toEqual(new Date(f.evidence.refundedAt));
    await submitExpense(f.ctx, { id: expense.id, expectedVersion: expense.version, reason: "Review the original remaining fee through the existing expense approval flow" }, { db });
    expect(externalRefundFeePlanSchema.parse(await readExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db })).state).toBe("APPROVED");
    expect(await getExpense(f.ctx, expense.id, { db })).toMatchObject({ canPost: false, canCorrect: false, canVoid: false });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db }), admitted = externalRefundViewSchema.parse(await executeExternalPaymentRefundCommand(f.ctx, { operation: "ADMIT", input: { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint } }, { db }));
    expect(admitted.admission?.occurredAt).toBe(f.evidence.refundedAt); expect(admitted.amount.amount).toBe("0.03");
  });
  it("withholds fee details and rolls back the financial read audit after final expense-view revocation", async () => {
    const f = await fixture(), write = audits.writeAuditEvent, before = await facts(f.org); let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { const result = await write(tx, event); if (event.action === "finance.external_payment.refund_fee_reviewed") {
      if (!("permission" in tx) || !("rolePermission" in tx)) throw Error("Actual native tenant transaction required"); const native = tx as unknown as TenantTransaction,
        permission = await native.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "expense:view" } } });
      await native.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); revoked = true;
    } return result; });
    await expect(readExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(revoked).toBe(true); expect(await facts(f.org)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { organizationId: f.org, action: "finance.external_payment.refund_fee_reviewed" } }))).toBe(0);
  });
  it("finishes successive partial refunds against one original cost chain after current allocation rules change", async () => {
    const f = await fixture(), first = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), cost = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: first.expenseId! } }));
    await submitExpense(f.ctx, { id: cost.id, expectedVersion: cost.version, reason: "Approve the original remaining cost before its first actual refund" }, { db });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db }); await admitExternalPaymentRefund(f.ctx, { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint }, { db });
    const preserved = await facts(f.org);
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
      value: { default_treatment: "INCLUDED_IN_COMMISSION" }, reason: "A later cost agreement cannot reassign the original provider fee" }));
    const draft = { depositId: f.input.receipt.idempotencyKey, accountId: f.merchant.id, amount: "0.04", currency: "MAD", method: "confirmed-paypal", externalReference: null, purpose: "Return the final original guest funds" },
      reviewed = await reviewGuestDepositRefund(f.ctx, draft, { db }), input = { captureId: f.captureId, refund: { ...draft, idempotencyKey: randomUUID(), reviewFingerprint: reviewed.reviewFingerprint, reason: "Finish refunding only the remaining original guest funds" } }, request = await requestExternalPaymentRefund(f.ctx, input, { db }),
      event = await withTenant(db, f.org, tx => tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.org, type: externalPaymentRefundRequested, payload: { path: ["intentId"], equals: request.id } } })), at = new Date().toISOString(),
      evidence = { refundId: "REFUND_" + randomUUID(), captureId: f.capture.paymentId, requestId: input.refund.idempotencyKey, amount: { amount: "0.04", currency: "MAD" }, state: "COMPLETED" as const, createdAt: at, updatedAt: at, refundedAt: at,
        settlement: { schemaVersion: 1 as const, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN" as const, gross: { amount: "0.04", currency: "MAD" }, fee: { amount: "0.01", currency: "MAD" }, net: { amount: "0.03", currency: "MAD" }, totalRefunded: { amount: "0.07", currency: "MAD" } } };
    await executeExternalPaymentRefundReference({ organizationId: f.org, outboxEventId: event.id }, { db, provider: { refund: () => Promise.resolve(evidence), lookupRefund: () => Promise.resolve(evidence) } });
    const last = await prepareExternalPaymentRefundFee(f.ctx, { intentId: request.id }, { db }); expect(last.expenseId).toBeNull();
    const finalReview = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: request.id }, { db }); await admitExternalPaymentRefund(f.ctx, { intentId: request.id, reviewFingerprint: finalReview.reviewFingerprint }, { db });
    const old = new Set(preserved.map(row => row.kind + row.id)); expect((await facts(f.org)).filter(row => old.has(row.kind + row.id))).toEqual(preserved);
    const proof = await withTenant(db, f.org, async tx => ({ costs: await tx.expense.findMany({ where: { organizationId: f.org } }), bindings: await tx.externalPaymentRefundFee.findMany({ where: { organizationId: f.org }, orderBy: { createdAt: "asc" } }), postings: await tx.posting.findMany({ where: { organizationId: f.org } }) }));
    expect(proof.costs).toHaveLength(2); expect(proof.costs.every(row => row.state === "VOIDED")).toBe(true); expect(proof.bindings).toHaveLength(2);
    expect(proof.bindings[1]).toMatchObject({ originalExpenseId: cost.id, correctionExpenseId: null });
    const sum = (rows: typeof proof.postings) => rows.reduce((total, row) => row.side === "DEBIT" ? total.add(Money.of(row.amount.toString(), row.currency)) : total.subtract(Money.of(row.amount.toString(), row.currency)), Money.zero("MAD"));
    expect(sum(proof.postings.filter(row => row.ledgerAccountId === f.merchant.id)).toJSON().amount).toBe("0.00"); expect(sum(proof.postings.filter(row => row.bucket === "OWNER_EXPENSE")).toJSON().amount).toBe("0.00"); expect(proof.postings.filter(row => row.bucket === "ALVILLAS_EXPENSE")).toHaveLength(0);
  });
  it("recovers concurrent financial admission once without duplicating either side of the fee return", async () => {
    const f = await fixture(), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), row = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } }));
    await submitExpense(f.ctx, { id: row.id, expectedVersion: row.version, reason: "Approve the exact remaining original cost once" }, { db });
    const before = await withTenant(db, f.org, tx => tx.financialTransaction.count({ where: { organizationId: f.org } })), review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db }), input = { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint }, results = await Promise.all([admitExternalPaymentRefund(f.ctx, input, { db }), admitExternalPaymentRefund(f.ctx, input, { db })]);
    expect(new Set(results.map(result => result.id)).size).toBe(1); expect(results.filter(result => result.idempotent)).toHaveLength(1);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count({ where: { organizationId: f.org } }))).toBe(before + 3);
  });
  it.each(["OWNER_PAID", "INCLUDED_IN_COMMISSION"] as const)("atomically admits the gross refund and exact %s returned cost at the verified provider date", async treatment => {
    const f = await fixture(treatment), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }),
      correction = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } })),
      approved = await submitExpense(f.ctx, { id: correction.id, expectedVersion: correction.version, reason: "Approve the original configured remaining provider cost" }, { db }), before = await facts(f.org),
      review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db }), input = { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint }, admitted = await admitExternalPaymentRefund(f.ctx, input, { db });
    expect(approved.state).toBe("APPROVED"); expect(admitted).toMatchObject({ operation: "REFUND", idempotent: false });
    const proof = await withTenant(db, f.org, async tx => ({ original: await tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: f.fee.id } }),
      correction: await tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: correction.id }, include: { transaction: { include: { postings: true } } } }),
      journals: await tx.financialTransaction.findMany({ where: { organizationId: f.org } }), merchant: await tx.posting.findMany({ where: { organizationId: f.org, ledgerAccountId: f.merchant.id } }) }));
    expect(proof.original.state).toBe("VOIDED"); expect(proof.correction.state).toBe("POSTED"); expect(proof.correction.amount.toFixed(2)).toBe("0.01");
    expect(proof.journals.every(journal => journal.sealed)).toBe(true);
    expect(proof.correction.transaction?.postings.find(row => row.side === "DEBIT")?.bucket).toBe(treatment === "OWNER_PAID" ? "OWNER_EXPENSE" : "ALVILLAS_EXPENSE");
    const old = new Set(before.map(row => row.kind + row.id)), after = await facts(f.org); expect(after.filter(row => old.has(row.kind + row.id))).toEqual(before);
    expect(proof.journals.filter(journal => !before.some(row => row.kind === "journal" && row.id === journal.id))).toHaveLength(3);
    for (const journal of proof.journals.filter(journal => !old.has("journal" + journal.id))) expect(journal.occurredAt.toISOString()).toBe(f.evidence.refundedAt);
    expect(proof.merchant.reduce((total, row) => row.side === "DEBIT" ? total.add(Money.of(row.amount.toString(), row.currency)) : total.subtract(Money.of(row.amount.toString(), row.currency)), Money.zero("MAD")).toJSON().amount).toBe("0.03");
    expect(await admitExternalPaymentRefund(f.ctx, input, { db })).toEqual({ ...admitted, idempotent: true }); expect(await facts(f.org)).toEqual(after);
  });
  it("atomically returns a fully credited fee without creating a zero-cost replacement", async () => {
    const f = await fixture("OWNER_PAID", "0.02"), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), before = await facts(f.org), review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db });
    expect(binding.expenseId).toBeNull(); await admitExternalPaymentRefund(f.ctx, { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint }, { db });
    expect((await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: f.fee.id } }))).state).toBe("VOIDED");
    const old = new Set(before.map(row => row.kind + row.id)), after = await facts(f.org); expect(after.filter(row => old.has(row.kind + row.id))).toEqual(before); expect(after.filter(row => row.kind === "journal" && !old.has(row.kind + row.id))).toHaveLength(2);
    expect(await withTenant(db, f.org, tx => tx.expense.count({ where: { organizationId: f.org } }))).toBe(1);
  });
  it("requires ordinary approval and forbids posting the provider cost offset apart from its guest refund", async () => {
    const f = await fixture(), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), row = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } })), before = await facts(f.org);
    await expect(reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError);
    const approved = await submitExpense(f.ctx, { id: row.id, expectedVersion: row.version, reason: "Apply the original ordinary expense approval requirements" }, { db });
    await expect(postExpense(f.ctx, { id: row.id, expectedVersion: approved.version, reason: "Refund only the reviewed original guest funds" }, { db })).rejects.toThrow();
    expect(await facts(f.org)).toEqual(before);
    const original = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: f.fee.id } }));
    await expect(voidExpense(f.ctx, { id: original.id, expectedVersion: original.version, reason: "Refund only the reviewed original guest funds" }, { db })).rejects.toThrow(); expect(await facts(f.org)).toEqual(before);
  });
  it("rolls cost opposites, replacements and gross refund back together after final independent expense-pay revocation", async () => {
    const f = await fixture(), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), row = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } }));
    await submitExpense(f.ctx, { id: row.id, expectedVersion: row.version, reason: "Approve the actual remaining provider cost" }, { db });
    const review = await reviewExternalPaymentRefundAdmission(f.ctx, { intentId: f.request.id }, { db }), before = await facts(f.org), write = audits.writeAuditEvent; let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { const result = await write(tx, event); if (event.action === "finance.external_payment.refund_admitted") {
      if (!("permission" in tx) || !("rolePermission" in tx)) throw Error("Actual native tenant transaction required"); const native = tx as unknown as TenantTransaction,
        permission = await native.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "expense:pay" } } });
      await native.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); revoked = true;
    } return result; });
    await expect(admitExternalPaymentRefund(f.ctx, { intentId: f.request.id, reviewFingerprint: review.reviewFingerprint }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(revoked).toBe(true); expect(await facts(f.org)).toEqual(before);
    expect((await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: f.fee.id } }))).state).toBe("POSTED");
  });
  it.each(["OWNER_PAID", "INCLUDED_IN_COMMISSION"] as const)("prepares an ordinary %s correction without changing any financial history", async treatment => {
    const f = await fixture(treatment), before = await facts(f.org), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db });
    expect(binding).toMatchObject({ state: "DRAFT", idempotent: false }); expect(binding.expenseId).not.toBeNull(); expect(await facts(f.org)).toEqual(before);
    const rows = await withTenant(db, f.org, async tx => ({ binding: await tx.externalPaymentRefundFee.findFirstOrThrow({ where: { organizationId: f.org, id: binding.id } }),
      original: await tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: f.fee.id } }), correction: await tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } }) }));
    expect(rows.original.state).toBe("POSTED"); expect(rows.binding.currentCost.toFixed(2)).toBe("0.02"); expect(rows.binding.returnedFee.toFixed(2)).toBe("0.01"); expect(rows.binding.remainingCost.toFixed(2)).toBe("0.01");
    expect(rows.correction).toMatchObject({ state: "DRAFT", correctsExpenseId: f.fee.id, correctsExpenseVersion: rows.original.version, fundingAccountId: rows.original.fundingAccountId, category: rows.original.category, purpose: rows.original.purpose });
    expect(await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db })).toEqual({ ...binding, idempotent: true }); expect(await facts(f.org)).toEqual(before);
  });
  it("reserves a verified full fee credit without creating a zero-cost expense or a financial movement", async () => {
    const f = await fixture("OWNER_PAID", "0.02"), before = await facts(f.org), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db });
    expect(binding.expenseId).toBeNull(); expect(await withTenant(db, f.org, tx => tx.expense.count({ where: { organizationId: f.org } }))).toBe(1); expect(await facts(f.org)).toEqual(before);
  });
  it("rolls the draft and binding back when their attributed preparation audit is missing", async () => {
    const f = await fixture(), before = await facts(f.org), write = audits.writeAuditEvent;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation((tx, event) => event.action === "finance.external_payment.refund_fee_prepared" ? Promise.resolve(undefined) : write(tx, event));
    await expect(prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db })).rejects.toThrow("fee");
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundFee.count({ where: { organizationId: f.org } }))).toBe(0); expect(await withTenant(db, f.org, tx => tx.expense.count({ where: { organizationId: f.org } }))).toBe(1); expect(await facts(f.org)).toEqual(before);
  });
  it("rolls back preparation when independent expense authority is revoked by the final audit write", async () => {
    const f = await fixture(), before = await facts(f.org), write = audits.writeAuditEvent; let revoked = false;
    vi.spyOn(audits, "writeAuditEvent").mockImplementation(async (tx, event) => { const result = await write(tx, event); if (event.action === "finance.external_payment.refund_fee_prepared") {
      if (!("permission" in tx) || !("rolePermission" in tx)) throw Error("Actual tenant transaction required"); const native = tx as unknown as TenantTransaction;
      const permission = await native.permission.findUniqueOrThrow({ where: { organizationId_key: { organizationId: f.org, key: "expense:void" } } });
      await native.rolePermission.deleteMany({ where: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } }); revoked = true;
    } return result; });
    await expect(prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError); expect(revoked).toBe(true);
    expect(await withTenant(db, f.org, tx => tx.externalPaymentRefundFee.count({ where: { organizationId: f.org } }))).toBe(0); expect(await facts(f.org)).toEqual(before);
  });
  it("recovers concurrent preparation once without duplicating a correction", async () => {
    const f = await fixture(), results = await Promise.all([prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db })]);
    expect(new Set(results.map(result => result.id)).size).toBe(1); expect(results.filter(result => result.idempotent)).toHaveLength(1); expect(await withTenant(db, f.org, tx => tx.expense.count({ where: { organizationId: f.org } }))).toBe(2);
  });
  it("rejects another tenant, preserves immutable bindings, and prevents unverified expense corrections", async () => {
    const f = await fixture(), other = await fixture(), before = await facts(f.org);
    await expect(prepareExternalPaymentRefundFee(other.ctx, { intentId: f.request.id }, { db })).rejects.toBeInstanceOf(ExternalPaymentRefundError);
    const original = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: f.fee.id } }));
    await expect(createExpenseCorrectionDraft(f.ctx, { id: original.id, expectedVersion: original.version, amount: "0.01", idempotencyKey: randomUUID(), reason: "A manual amount correction cannot borrow a provider fee credit" }, { db })).rejects.toThrow("fee plan");
    const binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db });
    await expect(withTenant(db, f.org, tx => tx.externalPaymentRefundFee.update({ where: { id: binding.id }, data: { returnedFee: "0.02" } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.externalPaymentRefundFee.delete({ where: { id: binding.id } }))).rejects.toThrow();
    expect(await withTenant(db, other.org, tx => tx.externalPaymentRefundFee.findFirst({ where: { id: binding.id } }))).toBeNull(); expect(await facts(f.org)).toEqual(before);
  });
  it("prevents editing the verified remaining cost even through the ordinary draft editor", async () => {
    const f = await fixture(), binding = await prepareExternalPaymentRefundFee(f.ctx, { intentId: f.request.id }, { db }), row = await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: binding.expenseId! } }));
    await expect(updateExpenseDraft(f.ctx, { id: row.id, expectedVersion: row.version, draft: { propertyId: row.propertyId, reservationId: row.reservationId, fundingAccountId: row.fundingAccountId,
      amount: "0.03", currency: row.currency, category: row.category, purpose: row.purpose, occurredOn: row.occurredOn.toISOString().slice(0, 10), emergency: false, idempotencyKey: row.idempotencyKey, reason: "An edited amount cannot change a verified provider fee return" } }, { db })).rejects.toThrow("provenance");
    expect((await withTenant(db, f.org, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.org, id: row.id } }))).amount.toFixed(2)).toBe("0.01");
  });
});
