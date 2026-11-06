import { providerRefundEvidenceSchema } from "@/platform/providers/payment-refund";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { Money } from "@/platform/money/money";
import { externalRefundAdmissionEvidence } from "../domain/external-payment-refund-admission-evidence";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import type { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";

type Request = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
/** Later read-only observations cannot rewrite an already admitted economic fact. */
export async function admittedExternalRefundSettlement(repository: ExternalPaymentRefundRepository, request: Request, journal: { id: string; createdBy: string | null; occurredAt: Date }) {
  const witness = await repository.admissionEvidence(request.id);
  if (!witness) {
    // Historical admissions have no pointer. Publish only a single unambiguous
    // retained completed settlement; never choose an arbitrary later version.
    const legacy = await repository.unambiguousCompletedSettlement(request.id);
    return legacy === null ? null : providerRefundSettlementSchema.parse(legacy);
  }
  const saved = externalRefundAdmissionEvidence.parse(witness.after);
  if (saved.intentId !== request.id || saved.transactionId !== journal.id || saved.originalRequestedBy !== request.requestedBy || saved.admittedBy !== journal.createdBy || witness.actorId !== journal.createdBy ||
    saved.originalRequestKey !== request.idempotencyKey || saved.originalRequestFingerprint !== request.requestFingerprint || saved.refundedAt !== journal.occurredAt.toISOString()) throw new ExternalPaymentRefundError();
  const retained = await repository.admissionSettlement(saved.settlementId), observation = retained?.evidence, evidence = providerRefundEvidenceSchema.safeParse(observation?.evidence), settlement = providerRefundSettlementSchema.safeParse(retained?.settlement);
  if (!retained || retained.evidenceId !== saved.evidenceId || observation?.identity.intentId !== request.id || observation.state !== "COMPLETED" || !evidence.success || !settlement.success || evidence.data.state !== "COMPLETED" ||
    evidence.data.refundId !== request.identity?.refundId || evidence.data.captureId !== request.capture.paymentId || evidence.data.requestId !== request.idempotencyKey ||
    !Money.of(evidence.data.amount.amount, evidence.data.amount.currency).equals(Money.of(request.amount.toString(), request.currency)) ||
    !Money.of(settlement.data.gross.amount, settlement.data.gross.currency).equals(Money.of(request.amount.toString(), request.currency))) throw new ExternalPaymentRefundError();
  return settlement.data;
}
