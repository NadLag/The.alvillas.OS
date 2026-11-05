import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { ExternalPaymentRepository } from "../infrastructure/external-payment-repository";
import { PaymentMethodRepository } from "../infrastructure/payment-method-repository";
import { guestDepositReceiptInput, guestDepositReviewInput } from "../domain/guest-deposit-command";
import { ExternalPaymentIntentError } from "../domain/external-payment-intent";
import { GuestDepositConflictError } from "../domain/guest-deposit";
import { authorizeExternalPaymentSource } from "./external-payment-access";
import { externalPaymentContext, originalExternalPaymentIntent } from "./external-payment-service";
import { inspectGuestDepositReceiptInTransaction, postGuestDepositReceipt } from "./guest-deposit-service";
import { admitNative, nativeTransaction, type NativeSource } from "./native-payment-providers";
import type { FinanceActorContext } from "./finance-access";
import { configuredPaymentMethod } from "../domain/payment-method";
import { assertExternalPaymentLocation } from "./external-payment-location";
import { providerCaptureSettlementSchema } from "@/platform/providers/payment-capture";
import { capturedPayPalAdmissionInput } from "../domain/external-payment-command";
import { ExternalPaymentFeeRepository } from "../infrastructure/external-payment-fee-repository";
import { postExpense } from "./expense-posting-service";
import { authorizeExternalPaymentFee } from "./external-payment-fee-service";

export { capturedPayPalAdmissionInput } from "../domain/external-payment-command";
/** The captured source is already durable. Every monetary effect still belongs to the original native receipt producer. */
export async function admitCapturedPayPalPayment(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = capturedPayPalAdmissionInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRepository(tx, ctx.organizationId), request = await repository.find(input.intentId);
    if (!request?.capture?.capturedAt) throw new ExternalPaymentIntentError();
    await authorizeExternalPaymentSource(ctx, tx, request);
    const saved = originalExternalPaymentIntent(request), command = guestDepositReceiptInput.parse({ ...saved.input.receipt,
      receivedAt: request.capture.capturedAt.toISOString(), reviewFingerprint: input.reviewFingerprint, paymentMethodFingerprint: input.paymentMethodFingerprint, reason: input.reason });
    const settlement = providerCaptureSettlementSchema.safeParse(request.capture.settlement);
    if (!settlement.success) throw new ExternalPaymentIntentError();
    const runner = nativeTransaction(tx), hasFee = Money.of(settlement.data.fee.amount, settlement.data.fee.currency).amount.gt(0);
    let postedFeeHere = false;
    if (hasFee) {
      const fee = await new ExternalPaymentFeeRepository(tx, ctx.organizationId).byCapture(request.capture.id);
      if (!fee || !input.fee || fee.expenseId !== input.fee.expenseId) throw new ExternalPaymentIntentError();
      const row = await authorizeExternalPaymentFee(ctx, tx, request, fee, true);
      if (row.state === "POSTED") {
        const accepted = await new PaymentMethodRepository(tx, ctx.organizationId).acceptance("PAYPAL_CAPTURE", request.capture.id);
        if (!accepted && input.fee.expectedVersion !== row.version) throw new ExternalPaymentIntentError();
      } else {
        await postExpense(ctx, { id: fee.expenseId, expectedVersion: input.fee.expectedVersion, reason: input.fee.reason }, { db: runner, requestId: deps.requestId }); postedFeeHere = true;
      }
    } else if (input.fee) throw new ExternalPaymentIntentError();
    const source: NativeSource = { adapter: "paypal", methodKey: command.method, namespace: "PAYPAL_CAPTURE", source: request.capture.id,
      amount: Money.of(command.amount, command.currency), command: hasFee ? { receipt: command, fee: input.fee } : command, paymentMethodFingerprint: command.paymentMethodFingerprint, reservationId: command.reservationId,
      retainedCatalog: inner => new PaymentMethodRepository(inner, ctx.organizationId).retainedCatalog({ ruleId: request.policyId, version: request.policyVersion,
        identity: saved.input.receipt.paymentMethodFingerprint, currency: command.currency }),
      preflight: borrowed => withTenant(borrowed, ctx.organizationId, async inner => {
        await authorizeExternalPaymentSource(ctx, inner, request, true);
        const prepared = await inspectGuestDepositReceiptInTransaction(ctx, guestDepositReviewInput.strip().parse(command), inner);
        const catalog = await new PaymentMethodRepository(inner, ctx.organizationId).retainedCatalog({ ruleId: request.policyId, version: request.policyVersion, identity: saved.input.receipt.paymentMethodFingerprint, currency: command.currency });
        assertExternalPaymentLocation(configuredPaymentMethod(catalog.policy, command.method, prepared.amount), prepared.location);
        if (prepared.fingerprint !== command.reviewFingerprint) throw new GuestDepositConflictError();
      }),
      post: borrowed => postGuestDepositReceipt(ctx, command, { db: borrowed, requestId: deps.requestId }) };
    const result = await admitNative(ctx, source, { db: runner, requestId: deps.requestId });
    if (input.fee) {
      const fee = await new ExternalPaymentFeeRepository(tx, ctx.organizationId).byCapture(request.capture.id); if (!fee) throw new ExternalPaymentIntentError();
      await authorizeExternalPaymentFee(ctx, tx, request, fee, true);
      if (postedFeeHere) await postExpense(ctx, { id: input.fee.expenseId, expectedVersion: input.fee.expectedVersion, reason: input.fee.reason }, { db: runner, requestId: deps.requestId });
    }
    await authorizeExternalPaymentSource(ctx, tx, request, !result.idempotent);
    return { id: result.paymentId, depositId: command.idempotencyKey, operation: "RECEIPT" as const, idempotent: result.idempotent };
  });
}
