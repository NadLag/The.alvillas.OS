import { z } from "zod";
import { Money } from "@/platform/money/money";
import { guestDepositRootSnapshot } from "./guest-deposit-snapshot";
import { serviceAllocationOwnerSchema } from "./service-allocation-snapshot-schema";
import { assertPropertyOwnerShares } from "./reservation-revenue";
import { GuestDepositSourceError } from "./guest-deposit";

const identity = z.uuid().transform(value => value.toLowerCase());
const financialSnapshot = z.object({ id: identity, organizationId: identity, reservationId: identity, version: z.number().int().positive(),
  rules: z.object({ owners: z.array(serviceAllocationOwnerSchema.strip()).min(1) }).strip() }).strip();
const sourceSchema = z.object({ organizationId: identity,
  transaction: z.object({ id: identity, organizationId: identity, createdBy: identity }).strict(),
  audit: z.object({ id: identity, actorId: identity }).strict(),
  actor: z.object({ organizationId: identity, id: identity, personId: identity }).strict(),
  receipt: guestDepositRootSnapshot,
  booking: z.object({ organizationId: identity, id: identity, propertyId: identity, guestId: identity, source: z.string().trim().min(1).max(120), financialSnapshot }).strict()
}).strict();
export class GuestPaymentProvenanceSourceError extends GuestDepositSourceError { constructor() { super(); this.message = "guest_payment_provenance_source_unavailable"; } }

/** Retains native receipt and booking witnesses; related owners establish context, not an allocation of guest money. */
export function captureGuestPaymentProvenance(raw: unknown) {
  const parsed = sourceSchema.safeParse(raw);
  if (!parsed.success) throw new GuestPaymentProvenanceSourceError();
  const { organizationId, transaction, audit, actor, receipt, booking } = parsed.data, source = receipt.source, retained = booking.financialSnapshot;
  if ([transaction.organizationId, actor.organizationId, booking.organizationId, source.organizationId, retained.organizationId].some(id => id !== organizationId) ||
    transaction.createdBy !== actor.id || audit.actorId !== transaction.createdBy || source.reservationId !== booking.id || retained.reservationId !== booking.id ||
    receipt.input.reservationId !== booking.id || source.propertyId !== booking.propertyId || source.guestId !== booking.guestId || source.depositId !== receipt.input.idempotencyKey ||
    new Set(retained.rules.owners.map(owner => owner.ownerId)).size !== retained.rules.owners.length) throw new GuestPaymentProvenanceSourceError();
  try { assertPropertyOwnerShares(retained.rules.owners); } catch { throw new GuestPaymentProvenanceSourceError(); }
  if (receipt.operation === "ADMIT_CASH") {
    const original = z.object({ reservationFinancialSnapshot: z.object({ id: identity, version: z.number().int().positive() }).strip() }).strip().safeParse(receipt.cashSource.provenance);
    if (!original.success || original.data.reservationFinancialSnapshot.id !== retained.id || original.data.reservationFinancialSnapshot.version !== retained.version || receipt.input.collectionId !== receipt.cashSource.id)
      throw new GuestPaymentProvenanceSourceError();
  }
  return {
    schemaVersion: 1 as const, organizationId, transactionId: transaction.id, originalAuditId: audit.id,
    depositId: source.depositId, operation: receipt.operation,
    amount: Money.of(receipt.input.amount, receipt.input.currency).toJSON(),
    recordedBy: { userAccountId: actor.id, personId: actor.personId },
    collectedBy: receipt.operation === "ADMIT_CASH" ? { userAccountId: receipt.cashSource.collectorUserAccountId, personId: receipt.cashSource.collectorPersonId } : { userAccountId: actor.id, personId: actor.personId },
    accountId: receipt.operation === "ADMIT_CASH" ? receipt.cashSource.custodyAccountId : receipt.input.accountId,
    claim: { guestId: source.guestId, liabilityAccountId: receipt.liabilityAccountId },
    booking: { reservationId: booking.id, propertyId: booking.propertyId, guestId: booking.guestId, source: booking.source, financialSnapshotId: retained.id, financialSnapshotVersion: retained.version },
    relatedOwners: retained.rules.owners.map(({ ownerId, shareBps }) => ({ ownerId, shareBps })),
    purpose: receipt.input.purpose,
    receivedAt: receipt.operation === "ADMIT_CASH" ? receipt.cashSource.recordedAt : receipt.input.receivedAt,
    externalReference: receipt.operation === "RECEIPT" ? receipt.input.externalReference : null,
    originalCollectionId: receipt.operation === "ADMIT_CASH" ? receipt.cashSource.id : null,
    originalCollectionTransactionId: receipt.operation === "ADMIT_CASH" ? receipt.cashSource.transactionId : null,
  };
}
export type GuestPaymentProvenance = ReturnType<typeof captureGuestPaymentProvenance>;
