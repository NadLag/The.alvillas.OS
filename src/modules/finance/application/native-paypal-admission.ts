import { z } from "zod";
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

export const capturedPayPalAdmissionInput = z.object({ intentId: z.uuid(), reviewFingerprint: guestDepositReceiptInput.shape.reviewFingerprint,
  paymentMethodFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), reason: guestDepositReceiptInput.shape.reason }).strict();
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
    if (!settlement.success || !Money.of(settlement.data.fee.amount, settlement.data.fee.currency).equals(Money.zero(command.currency))) throw new ExternalPaymentIntentError();
    const runner = nativeTransaction(tx), source: NativeSource = { adapter: "paypal", methodKey: command.method, namespace: "PAYPAL_CAPTURE", source: request.capture.id,
      amount: Money.of(command.amount, command.currency), command, paymentMethodFingerprint: command.paymentMethodFingerprint, reservationId: command.reservationId,
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
    await authorizeExternalPaymentSource(ctx, tx, request, !result.idempotent);
    return { id: result.paymentId, depositId: command.idempotencyKey, operation: "RECEIPT" as const, idempotent: result.idempotent };
  });
}
