import type { z } from "zod";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import type { TenantTransaction } from "@/platform/db/tenant";
import { providerRefundEvidenceSchema } from "@/platform/providers/payment-refund";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { guestDepositRefundReviewInput } from "../domain/guest-deposit-command";
import { retainExternalPaymentRefund, ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { externalPaymentRefundReviewSnapshot } from "../domain/external-payment-refund-review";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { externalRefundAdmissionEvidence } from "../domain/external-payment-refund-admission-evidence";
import type { FinanceActorContext } from "./finance-access";
import { externalRefundSupervisionAuthorityDetails, type ExternalRefundSupervisionAuthority } from "./external-refund-supervision-authority";

export type GuestRefundSourceScope = { reservationKey?: string; commandKey?: string; supervision?: ExternalRefundSupervisionAuthority };
/** A retained request restricts admission; its verified provider fact supplies the economic time. */
export async function guestDepositProviderRefundSource(ctx: FinanceActorContext, input: z.infer<typeof guestDepositRefundReviewInput>, tx: TenantTransaction, scope: GuestRefundSourceScope) {
  const key = scope.commandKey ?? scope.reservationKey;
  if (!key) return null;
  const repository = new GuestDepositRepository(tx, ctx.organizationId), request = await repository.externalRefundByKey(key);
  if (!request) { if (scope.reservationKey) throw new ExternalPaymentRefundError(); return null; }
  if (await repository.externalRefundCancellation(request.id)) throw new ExternalPaymentRefundError();
  const saved = retainExternalPaymentRefund(request.input, request.organizationId, request.requestedBy), audit = await repository.externalRefundReview(request.id), review = externalPaymentRefundReviewSnapshot.safeParse(audit?.after);
  const supervision = scope.supervision && scope.commandKey ? externalRefundSupervisionAuthorityDetails(scope.supervision, ctx, tx, request.id) : null;
  if ((!supervision && request.requestedBy !== ctx.actorId) || saved.fingerprint !== request.requestFingerprint || saved.canonicalRequest !== request.canonicalRequest ||
    !review.success || review.data.intentId !== request.id || review.data.reviewFingerprint !== saved.input.refund.reviewFingerprint || audit?.actorId !== request.requestedBy || audit.reason !== saved.input.refund.reason) throw new ExternalPaymentRefundError();
  const originalInput = guestDepositRefundReviewInput.strip().parse(saved.input.refund), heldContext: FinanceActorContext = supervision?.heldContext ?? { organizationId: ctx.organizationId, actorId: ctx.actorId, authContext: restoreAuthorizationCap(request.authorizationCap) };
  if (heldContext.authContext.organizationId !== ctx.organizationId || heldContext.authContext.userAccountId !== ctx.actorId) throw new ExternalPaymentRefundError();
  if (!scope.commandKey) {
    if (commandFingerprint(originalInput) !== commandFingerprint(input)) throw new ExternalPaymentRefundError();
    return { request, heldContext, policy: review.data.policy, refundedAt: null, afterWritten: undefined };
  }
  const observation = request.identity?.observations[0], evidence = providerRefundEvidenceSchema.safeParse(observation?.evidence), settlement = providerRefundSettlementSchema.safeParse(observation?.settlement?.settlement);
  if (!request.identity || !observation || !evidence.success || !settlement.success || evidence.data.state !== "COMPLETED" || !evidence.data.refundedAt ||
    evidence.data.refundId !== request.identity.refundId || evidence.data.captureId !== request.capture.paymentId || evidence.data.requestId !== key ||
    !Money.of(evidence.data.amount.amount, evidence.data.amount.currency).equals(Money.of(request.amount.toString(), request.currency)) ||
    !Money.of(settlement.data.gross.amount, settlement.data.gross.currency).equals(Money.of(request.amount.toString(), request.currency)) ||
    !Money.of(settlement.data.gross.amount, settlement.data.gross.currency).subtract(Money.of(settlement.data.fee.amount, settlement.data.fee.currency)).equals(Money.of(settlement.data.net.amount, settlement.data.net.currency)) ||
    (!Money.of(settlement.data.fee.amount, settlement.data.fee.currency).amount.isZero() && (!request.fee || request.fee.returnedFee.toFixed(2) !== settlement.data.fee.amount || request.fee.currency !== settlement.data.fee.currency)) ||
    commandFingerprint({ ...originalInput, externalReference: request.identity.refundId }) !== commandFingerprint(input)) throw new ExternalPaymentRefundError();
  const first = await repository.firstCompletedExternalRefund(request.identity.id);
  if (!first?.refundedAt) throw new ExternalPaymentRefundError();
  const afterWritten = async (journal: { id: string; occurredAt: Date }) => {
    const after = externalRefundAdmissionEvidence.parse({ schemaVersion: 1, intentId: request.id, transactionId: journal.id,
      originalRequestKey: request.idempotencyKey, originalRequestFingerprint: request.requestFingerprint, originalRequestedBy: request.requestedBy, admittedBy: ctx.actorId,
      evidenceId: observation.id, settlementId: observation.settlement!.id, firstEvidenceId: first.id, refundedAt: journal.occurredAt.toISOString() });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_admission_evidence", resourceType: "financial_transaction", resourceId: request.id,
      after, reason: saved.input.refund.reason, requestId: crypto.randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await supervision?.afterWritten?.(journal);
  };
  return { request, heldContext, policy: review.data.policy, refundedAt: first.refundedAt, afterWritten };
}
