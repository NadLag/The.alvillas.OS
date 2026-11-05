import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { captureGuestPaymentProvenance, GuestPaymentProvenanceSourceError } from "@/modules/finance/domain/guest-payment-provenance";

const labels = { en: "Original guest prepayment", fr: "Acompte original du séjour", ar: "دفعة الضيف الأصلية" };
function original() {
  const organizationId = randomUUID(), actorId = randomUUID(), personId = randomUUID(), depositId = randomUUID(), reservationId = randomUUID(), propertyId = randomUUID(), guestId = randomUUID();
  const policy = { id: randomUUID(), version: 1, value: { source: "ACTUAL_GUEST_RECEIPT", kinds: [{ key: "stay", labels, liability_account_code: "GUEST_PREPAYMENT", application: "ACCOMMODATION_PREPAYMENT" }],
    receipt_account_codes: ["BANK_A"], refund_account_codes: ["BANK_A"], receipt_bucket: "GUEST_DEPOSIT_RECEIPT", refund_bucket: "GUEST_DEPOSIT_REFUND", payment_methods: [{ key: "manual-original", labels }],
    refund_limit: "ORIGINAL_UNAPPLIED_UNREFUNDED_LIABILITY", closed_period: "REJECT", correction_date: "CURRENT_OPEN_PERIOD" } };
  return { organizationId, transaction: { id: randomUUID(), organizationId, createdBy: actorId }, audit: { id: randomUUID(), actorId },
    actor: { organizationId, id: actorId, personId }, receipt: { schemaVersion: 1, operation: "RECEIPT", commandHash: "a".repeat(64),
      input: { reservationId, kind: "stay", accountId: randomUUID(), amount: "9007199254740993.07", currency: "MAD", method: "manual-original", receivedAt: "2026-11-04T00:00:00.000Z", externalReference: "actual-original-bank-reference", purpose: "Original accommodation funds", reviewFingerprint: "b".repeat(64), idempotencyKey: depositId, reason: "Record original guest funds without allocating revenue" },
      source: { organizationId, depositId, reservationId, propertyId, guestId, kind: "stay", city: null, region: null }, policy, liabilityAccountId: randomUUID() },
    booking: { organizationId, id: reservationId, propertyId, guestId, source: "DIRECT", financialSnapshot: { id: randomUUID(), organizationId, reservationId, version: 1,
      rules: { owners: [{ ownerId: randomUUID(), ownerName: "Original confirmed owner", shareBps: 10000 }] } } } };
}
function cashOriginal() {
  const source = original(), collectedBy = { userAccountId: randomUUID(), personId: randomUUID() }, { accountId, method, receivedAt, externalReference, ...input } = source.receipt.input;
  void accountId; void method; void receivedAt; void externalReference;
  const cashSource = { id: randomUUID(), transactionId: randomUUID(), custodyAccountId: randomUUID(), taskId: randomUUID(), taskType: "ARRIVAL_PREPARATION", recordedAt: "2026-11-03T00:00:00.000Z", amount: input.amount, currency: input.currency,
    collectorUserAccountId: collectedBy.userAccountId, collectorPersonId: collectedBy.personId, provenance: { reservationFinancialSnapshot: structuredClone(source.booking.financialSnapshot) } };
  return { ...source, receipt: { ...source.receipt, operation: "ADMIT_CASH", input: { ...input, collectionId: cashSource.id }, unallocatedAccountId: randomUUID(), cashSource }, collectedBy };
}
describe("full original guest-payment provenance", () => {
  it("retains exact original money and links the native receipt, collector, account, booking, guest, purpose and frozen owners", () => {
    const source = original(), before = structuredClone(source), result = captureGuestPaymentProvenance(source);
    expect(result.amount).toEqual({ amount: "9007199254740993.07", currency: "MAD" });
    expect(result.transactionId).toBe(source.transaction.id); expect(result.originalAuditId).toBe(source.audit.id);
    expect(result.collectedBy).toEqual({ userAccountId: source.actor.id, personId: source.actor.personId });
    expect(result.accountId).toBe(source.receipt.input.accountId);
    expect(result.booking).toMatchObject({ reservationId: source.booking.id, propertyId: source.booking.propertyId, guestId: source.booking.guestId, source: "DIRECT", financialSnapshotId: source.booking.financialSnapshot.id });
    expect(result.relatedOwners).toEqual(source.booking.financialSnapshot.rules.owners.map(({ ownerId, shareBps }) => ({ ownerId, shareBps })));
    expect(result.claim).toEqual({ guestId: source.booking.guestId, liabilityAccountId: source.receipt.liabilityAccountId });
    expect(result.purpose).toBe(source.receipt.input.purpose); expect(source).toEqual(before);
  });
  it("keeps the actual original cash collector distinct from the later financial admission actor and claim account", () => {
    const source = cashOriginal(), { collectedBy, ...input } = source, result = captureGuestPaymentProvenance(input);
    expect(result.collectedBy).toEqual(collectedBy); expect(result.recordedBy.userAccountId).toBe(source.actor.id);
    expect(result.accountId).toBe(source.receipt.cashSource.custodyAccountId); expect(result.accountId).not.toBe(source.receipt.unallocatedAccountId);
    expect(result.receivedAt).toBe(source.receipt.cashSource.recordedAt); expect(result.originalCollectionId).toBe(source.receipt.cashSource.id);
  });
  it.each(["transaction", "actor", "booking"] as const)("rejects a foreign organization on the original %s", part => {
    const source = original(); source[part].organizationId = randomUUID();
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it.each(["propertyId", "guestId"] as const)("rejects a substituted booking %s", field => {
    const source = original(); source.booking[field] = randomUUID();
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it("rejects a substituted original recording actor", () => {
    const source = original(); source.actor.id = randomUUID();
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it("rejects an original financial audit attributed to another actor", () => {
    const source = original(); source.audit.actorId = randomUUID();
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it.each(["organizationId", "reservationId"] as const)("rejects a foreign %s on the retained financial snapshot", field => {
    const source = original(); source.booking.financialSnapshot[field] = randomUUID();
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it("requires actual frozen owners without falling back to present property ownership", () => {
    const source = original(); source.booking.financialSnapshot.rules.owners = [];
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it("rejects duplicate frozen owner identities", () => {
    const source = original(), owner = source.booking.financialSnapshot.rules.owners[0]; source.booking.financialSnapshot.rules.owners = [{ ...owner, shareBps: 5000 }, { ...owner, shareBps: 5000 }];
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
  it("rejects a different financial snapshot from the original cash evidence", () => {
    const { collectedBy, ...source } = cashOriginal(); void collectedBy; source.booking.financialSnapshot.id = randomUUID();
    expect(() => captureGuestPaymentProvenance(source)).toThrow(GuestPaymentProvenanceSourceError);
  });
});
