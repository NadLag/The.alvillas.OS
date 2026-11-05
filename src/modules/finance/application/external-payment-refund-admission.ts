import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { guestDepositRefundReviewInput, guestDepositRefundInput } from "../domain/guest-deposit-command";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { inspectGuestDepositRefundInTransaction, postGuestDepositRefund, recoverGuestDepositCommand, presentGuestDepositResult } from "./guest-deposit-service";
import { externalPaymentContext } from "./external-payment-service";
import { nativeTransaction } from "./native-payment-providers";
import type { FinanceActorContext } from "./finance-access";
import { retainedExternalRefund as retained, authorizeExternalRefundSourceView as sourceView } from "./external-payment-refund-access";
import { inspectExternalRefundFeeAdmission, postExternalRefundFeeAdmission } from "./external-payment-refund-fee-service";

const reference = z.object({ intentId: z.uuid() }).strict();
const command = reference.extend({ reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
async function prepare(ctx: FinanceActorContext, tx: TenantTransaction, request: Request) {
  const saved = retained(request, ctx); if (!request.identity) throw new ExternalPaymentRefundError();
  const draft = guestDepositRefundReviewInput.strip().parse({ ...saved.input.refund, externalReference: request.identity.refundId }),
    prepared = await inspectGuestDepositRefundInTransaction(ctx, draft, tx, { commandKey: request.idempotencyKey });
  const fee = await inspectExternalRefundFeeAdmission(ctx, tx, request), fingerprint = fee ? commandFingerprint({ guestRefund: prepared.fingerprint, fee: fee.fingerprint }) : prepared.fingerprint;
  return { saved, draft, prepared, fee, fingerprint };
}
export async function reviewExternalPaymentRefundAdmission(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = reference.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).find(input.intentId); if (!request) throw new ExternalPaymentRefundError();
    await sourceView(ctx, tx, request);
    if (await new GuestDepositRepository(tx, ctx.organizationId).byCommand(request.idempotencyKey)) throw new ExternalPaymentRefundError();
    const p = await prepare(ctx, tx, request), result = presentGuestDepositResult(ctx, p.prepared.resource, { intentId: request.id, depositId: request.depositId, refundId: request.identity!.refundId,
      amount: Money.of(request.amount.toString(), request.currency).toJSON(), refundedAt: p.prepared.refundedAt.toISOString(), reviewFingerprint: p.fingerprint }, p.prepared.now);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_admission_reviewed", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, reviewFingerprint: p.fingerprint, refundedAt: p.prepared.refundedAt.toISOString() }, reason: "Reviewed independently verified original provider refund for native financial admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await p.prepared.finance.clock() });
    if ((await prepare(ctx, tx, request)).fingerprint !== p.fingerprint) throw new ExternalPaymentRefundError(); await sourceView(ctx, tx, request); return result;
  });
}
export async function admitExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = command.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).find(input.intentId); if (!request) throw new ExternalPaymentRefundError();
    const saved = retained(request, ctx), native = new GuestDepositRepository(tx, ctx.organizationId); await native.lockCommand(request.idempotencyKey); await native.lockSource(request.depositId);
    const existing = await native.byCommand(request.idempotencyKey);
    if (existing) {
      await sourceView(ctx, tx, request, existing);
      const recovered = await recoverGuestDepositCommand(ctx, { key: request.idempotencyKey }, { db: nativeTransaction(tx), requestId: deps.requestId });
      if (!recovered.request || recovered.request.operation !== "REFUND" || recovered.request.depositId !== request.depositId) throw new ExternalPaymentRefundError();
      await sourceView(ctx, tx, request, existing); return recovered.request;
    }
    await sourceView(ctx, tx, request); const p = await prepare(ctx, tx, request);
    if (p.fingerprint !== input.reviewFingerprint) throw new ExternalPaymentRefundError();
    if (p.fee) await postExternalRefundFeeAdmission(ctx, tx, request, p.fee, deps.requestId);
    const receipt = guestDepositRefundInput.parse({ ...saved.input.refund, externalReference: request.identity!.refundId, reviewFingerprint: p.prepared.fingerprint });
    const result = await postGuestDepositRefund(ctx, receipt, { db: nativeTransaction(tx), requestId: deps.requestId });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_admitted", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, transactionId: result.id, depositId: request.depositId }, reason: saved.input.refund.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await p.prepared.finance.clock() });
    await p.prepared.recheck(await p.prepared.finance.clock()); await p.prepared.periods.assertPostingOpen(p.prepared.refundedAt);
    await p.fee?.recheck();
    const journal = await native.byCommand(request.idempotencyKey); if (!journal) throw new ExternalPaymentRefundError(); await sourceView(ctx, tx, request, journal); return result;
  });
}
