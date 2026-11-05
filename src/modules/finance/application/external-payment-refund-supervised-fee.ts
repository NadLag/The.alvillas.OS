import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { externalRefundSupervisionFeeInput } from "../domain/external-payment-refund-supervision";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { externalPaymentContext } from "./external-payment-service";
import { inspectExternalRefundForSupervision } from "./external-payment-refund-supervision";
import { issueExternalRefundSupervisionAuthority, type ExternalRefundSupervisionAuthority } from "./external-refund-supervision-authority";
import { readExternalPaymentRefundFee, prepareExternalPaymentRefundFee } from "./external-payment-refund-fee-service";
import { nativeTransaction } from "./native-payment-providers";
import type { FinanceActorContext } from "./finance-access";

type Options = { db?: TenantTransactionRunner; requestId?: string; supervision?: ExternalRefundSupervisionAuthority };
async function run<T>(inputContext: FinanceActorContext, raw: unknown, operation: (ctx: FinanceActorContext, raw: unknown, options: Options) => Promise<T>, deps: Options) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundSupervisionFeeInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), request = await repository.find(input.intentId), audit = await repository.supervisionReview(input.reviewId, ctx.actorId), after = audit?.after;
    if (!request || request.requestedBy === ctx.actorId || !audit || audit.resourceId !== request.id || audit.reason !== input.reason || !after || typeof after !== "object" || Array.isArray(after) ||
      after.reviewFingerprint !== input.reviewFingerprint || after.reason !== input.reason || !await repository.committedAudit(audit.id)) throw new ExternalPaymentRefundError();
    const restriction: FinanceActorContext = { organizationId: ctx.organizationId, actorId: ctx.actorId, authContext: restoreAuthorizationCap(after.authorizationCap) },
      source = await inspectExternalRefundForSupervision(ctx, tx, request), old = await inspectExternalRefundForSupervision(restriction, tx, request);
    if (source.fingerprint !== old.fingerprint || commandFingerprint({ source: source.fingerprint, reason: input.reason }) !== input.reviewFingerprint) throw new ExternalPaymentRefundError();
    const supervision = issueExternalRefundSupervisionAuthority({ tx, organizationId: ctx.organizationId, actorId: ctx.actorId, intentId: request.id, heldContext: restriction,
      review: { id: input.reviewId, fingerprint: input.reviewFingerprint, reason: input.reason } }), options = { db: nativeTransaction(tx), requestId: deps.requestId, supervision };
    return operation(ctx, { intentId: request.id }, options);
  });
}
export const prepareSupervisedExternalPaymentRefundFee = (ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) => run(ctx, raw, prepareExternalPaymentRefundFee, deps);
export const readSupervisedExternalPaymentRefundFee = (ctx: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) => run(ctx, raw, readExternalPaymentRefundFee, deps);
