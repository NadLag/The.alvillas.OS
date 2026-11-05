import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { guestDepositRefundReviewInput, guestDepositRefundInput } from "../domain/guest-deposit-command";
import { retainExternalPaymentRefund, ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { inspectGuestDepositRefundInTransaction, postGuestDepositRefund, recoverGuestDepositCommand, readGuestDepositSourceInTransaction, presentGuestDepositResult } from "./guest-deposit-service";
import { externalPaymentContext } from "./external-payment-service";
import { nativeTransaction } from "./native-payment-providers";
import { employeeSettlementFundingChecks } from "./employee-compensation-settlement";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

const reference = z.object({ intentId: z.uuid() }).strict();
const command = reference.extend({ reviewFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
function retained(request: Request, ctx: FinanceActorContext) {
  const saved = retainExternalPaymentRefund(request.input, request.organizationId, request.requestedBy);
  if (ctx.actorId !== request.requestedBy || ctx.organizationId !== request.organizationId || saved.fingerprint !== request.requestFingerprint || saved.canonicalRequest !== request.canonicalRequest) throw new ExternalPaymentRefundError();
  return saved;
}
export { retained as retainedExternalRefund, sourceView as authorizeExternalRefundSourceView };
async function sourceView(ctx: FinanceActorContext, tx: TenantTransaction, request: Request, journal?: { id: string; occurredAt: Date }) {
  const saved = retained(request, ctx), contexts = [ctx, { ...ctx, authContext: restoreAuthorizationCap(request.authorizationCap) }];
  for (const actor of contexts) {
    const source = await readGuestDepositSourceInTransaction(actor, saved.input.refund.depositId, tx);
    if (source.location.id !== saved.input.refund.accountId) throw new ExternalPaymentRefundError();
    const at = journal?.occurredAt ?? request.identity?.observations[0]?.refundedAt ?? request.requestedAt, target = { ...source.resource, id: journal?.id ?? request.id, financialRecordId: journal?.id ?? request.id, occurredAt: at, amount: saved.input.refund.amount };
    await recheckFinanceAuthorization(actor, tx, await source.finance.clock(), [{ action: "view", resource: target }, ...employeeSettlementFundingChecks(actor, source.location, saved.input.refund.amount, at, "view")], new ExternalPaymentRefundError());
  }
}
async function prepare(ctx: FinanceActorContext, tx: TenantTransaction, request: Request) {
  const saved = retained(request, ctx); if (!request.identity) throw new ExternalPaymentRefundError();
  const draft = guestDepositRefundReviewInput.strip().parse({ ...saved.input.refund, externalReference: request.identity.refundId }),
    prepared = await inspectGuestDepositRefundInTransaction(ctx, draft, tx, { commandKey: request.idempotencyKey });
  return { saved, draft, prepared };
}
export async function reviewExternalPaymentRefundAdmission(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = reference.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).find(input.intentId); if (!request) throw new ExternalPaymentRefundError();
    await sourceView(ctx, tx, request);
    if (await new GuestDepositRepository(tx, ctx.organizationId).byCommand(request.idempotencyKey)) throw new ExternalPaymentRefundError();
    const p = await prepare(ctx, tx, request), result = presentGuestDepositResult(ctx, p.prepared.resource, { intentId: request.id, depositId: request.depositId, refundId: request.identity!.refundId,
      amount: Money.of(request.amount.toString(), request.currency).toJSON(), refundedAt: p.prepared.refundedAt.toISOString(), reviewFingerprint: p.prepared.fingerprint }, p.prepared.now);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_admission_reviewed", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, reviewFingerprint: p.prepared.fingerprint, refundedAt: p.prepared.refundedAt.toISOString() }, reason: "Reviewed independently verified original provider refund for native financial admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await p.prepared.finance.clock() });
    if ((await prepare(ctx, tx, request)).prepared.fingerprint !== p.prepared.fingerprint) throw new ExternalPaymentRefundError(); await sourceView(ctx, tx, request); return result;
  });
}
export async function admitExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = command.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).find(input.intentId); if (!request) throw new ExternalPaymentRefundError();
    const saved = retained(request, ctx), native = new GuestDepositRepository(tx, ctx.organizationId); await native.lockCommand(request.idempotencyKey);
    const existing = await native.byCommand(request.idempotencyKey);
    if (existing) {
      await sourceView(ctx, tx, request, existing);
      const recovered = await recoverGuestDepositCommand(ctx, { key: request.idempotencyKey }, { db: nativeTransaction(tx), requestId: deps.requestId });
      if (!recovered.request || recovered.request.operation !== "REFUND" || recovered.request.depositId !== request.depositId) throw new ExternalPaymentRefundError();
      await sourceView(ctx, tx, request, existing); return recovered.request;
    }
    await sourceView(ctx, tx, request); const p = await prepare(ctx, tx, request);
    if (p.prepared.fingerprint !== input.reviewFingerprint) throw new ExternalPaymentRefundError();
    const receipt = guestDepositRefundInput.parse({ ...saved.input.refund, externalReference: request.identity!.refundId, reviewFingerprint: input.reviewFingerprint });
    const result = await postGuestDepositRefund(ctx, receipt, { db: nativeTransaction(tx), requestId: deps.requestId });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_admitted", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, transactionId: result.id, depositId: request.depositId }, reason: saved.input.refund.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await p.prepared.finance.clock() });
    await p.prepared.recheck(await p.prepared.finance.clock()); await p.prepared.periods.assertPostingOpen(p.prepared.refundedAt);
    const journal = await native.byCommand(request.idempotencyKey); if (!journal) throw new ExternalPaymentRefundError(); await sourceView(ctx, tx, request, journal); return result;
  });
}
