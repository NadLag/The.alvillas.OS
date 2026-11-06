import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { PaymentMethodRepository } from "@/modules/finance/infrastructure/payment-method-repository";
import { guestPaymentMethodScopes } from "@/modules/finance/application/guest-deposit-payment-method";
import { inspectGuestDepositReceiptInTransaction, reviewGuestDepositRefund } from "@/modules/finance/application/guest-deposit-service";
import { requestExternalPaymentCapture, executeExternalPaymentCaptureReference, externalPaymentCaptureRequested } from "@/modules/finance/application/external-payment-service";
import { reviewCapturedPayPalAdmission } from "@/modules/finance/application/external-payment-workspace-service";
import { admitCapturedPayPalPayment } from "@/modules/finance/application/native-paypal-admission";
import { prepareExternalPaymentFee } from "@/modules/finance/application/external-payment-fee-service";
import { submitExpense } from "@/modules/finance/application/expense-service";
import { requestExternalPaymentRefund, executeExternalPaymentRefundReference, externalPaymentRefundRequested } from "@/modules/finance/application/external-payment-refund-service";
import { Money } from "@/platform/money/money";
import { actualGuestDepositFixture } from "./guest-deposit-fixture";

const labels = { en: "Original PayPal", fr: "PayPal initial", ar: "باي بال الأصلي" };
export async function actualProviderRefundFeeFixture(db: PrismaClient, admin: PrismaClient, treatment: "OWNER_PAID" | "INCLUDED_IN_COMMISSION" = "OWNER_PAID", returnedFee = "0.01", ownerShares = [10000]) {
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
  return { ...f, ctx, input, refundInput, request, fee, capture, evidence, captureId: observed.captureId!, merchant };
}
