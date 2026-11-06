import { isDeepStrictEqual } from "node:util";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ExternalPaymentRefundError, assertExternalPaymentRefund } from "../domain/external-payment-refund-intent";
import { externalRefundSupervisionReviewInput, externalRefundSupervisionAdmissionInput, externalRefundSupervisionRecoveryInput, externalRefundSupervisedAdmissionReview } from "../domain/external-payment-refund-supervision";
import { guestDepositRefundReviewInput, guestDepositRefundInput } from "../domain/guest-deposit-command";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { externalPaymentContext } from "./external-payment-service";
import { inspectExternalRefundForSupervision } from "./external-payment-refund-supervision";
import { issueExternalRefundSupervisionAuthority } from "./external-refund-supervision-authority";
import { inspectGuestDepositRefundInTransaction, postGuestDepositRefund, recoverGuestDepositCommand, readGuestDepositSourceInTransaction, presentGuestDepositResult } from "./guest-deposit-service";
import { employeeSettlementFundingChecks } from "./employee-compensation-settlement";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { nativeTransaction } from "./native-payment-providers";
import { inspectExternalRefundFeeAdmission, postExternalRefundFeeAdmission } from "./external-payment-refund-fee-service";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const held = (ctx: FinanceActorContext, raw: unknown): FinanceActorContext => ({ organizationId: ctx.organizationId, actorId: ctx.actorId, authContext: restoreAuthorizationCap(raw) });
async function prepare(ctx: FinanceActorContext, tx: TenantTransaction, request: Request, restriction = ctx) {
  const source = await inspectExternalRefundForSupervision(ctx, tx, request);
  if (ctx.actorId === request.requestedBy) throw new ExternalPaymentRefundError();
  await inspectExternalRefundForSupervision(restriction, tx, request);
  const authority = issueExternalRefundSupervisionAuthority({ tx, organizationId: ctx.organizationId, actorId: ctx.actorId, intentId: request.id, heldContext: restriction }),
    draft = guestDepositRefundReviewInput.strip().parse({ ...source.verified.saved.input.refund, externalReference: request.identity!.refundId }),
    native = await inspectGuestDepositRefundInTransaction(ctx, draft, tx, { commandKey: request.idempotencyKey, supervision: authority }),
    fee = await inspectExternalRefundFeeAdmission(ctx, tx, request, authority), fingerprint = fee ? commandFingerprint({ guestRefund: native.fingerprint, fee: fee.fingerprint }) : native.fingerprint;
  return { source, draft, native, fee, authority, fingerprint };
}
export async function reviewSupervisedExternalPaymentRefundAdmission(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundSupervisionReviewInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), request = await repository.find(input.intentId); if (!request) throw new ExternalPaymentRefundError();
    const p = await prepare(ctx, tx, request), reviewId = crypto.randomUUID(), reviewFingerprint = commandFingerprint({ source: p.source.fingerprint, guestRefund: p.fingerprint, reason: input.reason }),
      after = externalRefundSupervisedAdmissionReview.parse({ schemaVersion: 1, reviewId, intentId: request.id, reviewFingerprint, sourceFingerprint: p.source.fingerprint,
        guestRefundFingerprint: p.fingerprint, reason: input.reason, originalRequestedBy: request.requestedBy, originalRequestKey: request.idempotencyKey,
        originalRequestFingerprint: request.requestFingerprint, settlementId: p.source.verified.observation.settlement!.id, firstEvidenceId: p.source.basis.firstEvidenceId,
        refundedAt: p.source.refundedAt.toISOString(), authorizationCap: captureAuthorizationCap(ctx.authContext) });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_supervised_admission_reviewed", resourceType: "financial_transaction", resourceId: request.id,
      propertyScopeId: p.source.target.propertyId, after: json(after), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await p.native.finance.clock() });
    const audit = await repository.supervisedAdmissionReview(reviewId, ctx.actorId);
    if (!audit || audit.resourceId !== request.id || audit.reason !== input.reason || !isDeepStrictEqual(audit.after, json(after))) throw new ExternalPaymentRefundError();
    const fresh = await prepare(ctx, tx, request); if (fresh.source.fingerprint !== p.source.fingerprint || fresh.fingerprint !== p.fingerprint) throw new ExternalPaymentRefundError();
    return presentGuestDepositResult(ctx, p.source.target, { intentId: request.id, reviewId, reviewFingerprint, originalRequestedBy: request.requestedBy, prospectiveAdmitter: ctx.actorId,
      amount: p.source.verified.settlement.gross, refundedAt: after.refundedAt, reason: input.reason }, await p.native.finance.clock());
  });
}
async function recover(ctx: FinanceActorContext, tx: TenantTransaction, key: string, deps: Deps) {
  const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), witness = await repository.supervisedAdmissionByKey(key, ctx.actorId);
  if (!witness?.resourceId || !witness.after || typeof witness.after !== "object" || Array.isArray(witness.after)) return null;
  const savedWitness = witness.after, request = await repository.find(witness.resourceId), reviewId = savedWitness.reviewId;
  if (!request || typeof reviewId !== "string") throw new ExternalPaymentRefundError();
  const audit = await repository.supervisedAdmissionReview(reviewId, ctx.actorId), review = externalRefundSupervisedAdmissionReview.safeParse(audit?.after);
  if (!review.success || review.data.intentId !== request.id || audit?.reason !== witness.reason || review.data.reason !== witness.reason || review.data.reviewFingerprint !== savedWitness.reviewFingerprint) throw new ExternalPaymentRefundError();
  assertExternalPaymentRefund(request);
  const native = new GuestDepositRepository(tx, ctx.organizationId), journal = await native.byCommand(request.idempotencyKey);
  if (!journal || journal.id !== savedWitness.transactionId || journal.createdBy !== ctx.actorId) throw new ExternalPaymentRefundError();
  const recheck = async () => {
    for (const actor of [ctx, held(ctx, review.data.authorizationCap)]) {
      const source = await readGuestDepositSourceInTransaction(actor, request.depositId, tx), target = { ...source.resource, id: journal.id, financialRecordId: journal.id, occurredAt: journal.occurredAt, amount: request.amount.toFixed(2) };
      await recheckFinanceAuthorization(actor, tx, await source.finance.clock(), [{ action: "view", resource: target }, ...employeeSettlementFundingChecks(actor, source.location, request.amount.toFixed(2), journal.occurredAt, "view")], new ExternalPaymentRefundError());
    }
  };
  await recheck();
  const result = await recoverGuestDepositCommand(ctx, { key: request.idempotencyKey }, { db: nativeTransaction(tx), requestId: deps.requestId });
  if (!result.request || result.request.id !== journal.id || result.request.operation !== "REFUND") throw new ExternalPaymentRefundError();
  await recheck(); return { ...result.request, intentId: request.id, reviewId, reviewFingerprint: review.data.reviewFingerprint, reason: review.data.reason };
}
export async function admitSupervisedExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundSupervisionAdmissionInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), native = new GuestDepositRepository(tx, ctx.organizationId);
    await native.lockCommand(input.idempotencyKey); const recovered = await recover(ctx, tx, input.idempotencyKey, deps);
    if (recovered) { if (recovered.intentId !== input.intentId || recovered.reviewId !== input.reviewId || recovered.reviewFingerprint !== input.reviewFingerprint || recovered.reason !== input.reason) throw new ExternalPaymentRefundError(); return recovered; }
    const request = await repository.find(input.intentId), audit = await repository.supervisedAdmissionReview(input.reviewId, ctx.actorId), review = externalRefundSupervisedAdmissionReview.safeParse(audit?.after);
    if (!request || !audit || !review.success || audit.resourceId !== request.id || audit.reason !== input.reason || review.data.reason !== input.reason || review.data.intentId !== request.id ||
      review.data.reviewFingerprint !== input.reviewFingerprint || !await repository.committedAudit(audit.id)) throw new ExternalPaymentRefundError();
    await native.lockCommand(request.idempotencyKey); await native.lockSource(request.depositId);
    const restriction = held(ctx, review.data.authorizationCap), p = await prepare(ctx, tx, request, restriction);
    if (p.source.fingerprint !== review.data.sourceFingerprint || p.fingerprint !== review.data.guestRefundFingerprint ||
      commandFingerprint({ source: p.source.fingerprint, guestRefund: p.fingerprint, reason: input.reason }) !== input.reviewFingerprint) throw new ExternalPaymentRefundError();
    const after = { reviewId: input.reviewId, reviewFingerprint: input.reviewFingerprint, intentId: request.id, commandKey: input.idempotencyKey,
      originalRequestedBy: request.requestedBy, admittedBy: ctx.actorId, originalRequestKey: request.idempotencyKey }, requestId = deps.requestId ?? crypto.randomUUID(),
      finalAuthorization = async () => { for (const actor of [ctx, restriction]) await recheckFinanceAuthorization(actor, tx, await p.native.finance.clock(),
        [{ action: "view", resource: p.source.target }, { action: "override", resource: p.source.target }, { action: "reconcile", resource: p.source.target }], new ExternalPaymentRefundError()); await p.native.recheck(await p.native.finance.clock()); await p.fee?.recheck(); };
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_supervised_authorized", resourceType: "financial_transaction", resourceId: request.id,
      propertyScopeId: p.source.target.propertyId, after, reason: input.reason, requestId, occurredAt: await p.native.finance.clock() });
    await finalAuthorization();
    if (p.fee) await postExternalRefundFeeAdmission(ctx, tx, request, p.fee, requestId, p.authority);
    const authority = issueExternalRefundSupervisionAuthority({ tx, organizationId: ctx.organizationId, actorId: ctx.actorId, intentId: request.id, heldContext: restriction,
      afterWritten: async journal => { await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_supervised_admitted", resourceType: "financial_transaction", resourceId: request.id,
        propertyScopeId: p.source.target.propertyId, after: { ...after, transactionId: journal.id }, reason: input.reason, requestId, occurredAt: await p.native.finance.clock() }); await finalAuthorization(); } });
    const receipt = guestDepositRefundInput.parse({ ...p.source.verified.saved.input.refund, externalReference: request.identity!.refundId, reviewFingerprint: p.native.fingerprint }),
      result = await postGuestDepositRefund(ctx, receipt, { db: nativeTransaction(tx), requestId, supervision: authority });
    await finalAuthorization(); return { ...result, intentId: request.id, reviewId: input.reviewId, reviewFingerprint: input.reviewFingerprint, reason: input.reason };
  });
}
export async function recoverSupervisedExternalPaymentRefund(inputContext: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundSupervisionRecoveryInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const native = new GuestDepositRepository(tx, ctx.organizationId); await native.lockCommand(input.key); const request = await recover(ctx, tx, input.key, deps);
    if (!request) await recheckFinanceAuthorization(ctx, tx, await new FinanceRepository(tx, ctx.organizationId).clock(), [{ action: "view", resource: { type: "financial_transaction", organizationId: ctx.organizationId, dataClass: "financial" } }], new ExternalPaymentRefundError());
    return { request };
  });
}
