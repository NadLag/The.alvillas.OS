import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { GuestPaymentProvenance } from "../domain/guest-payment-provenance";

/** Retained native witnesses only; the original journal remains the complete monetary source. */
export class GuestPaymentProvenanceRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  find(transactionId: string) {
    return this.tx.guestPaymentReceipt.findUnique({ where: { organizationId_transactionId: { organizationId: this.organizationId, transactionId } }, include: { owners: { orderBy: { ordinal: "asc" } } } });
  }
  async source(transactionId: string) {
    const [transaction, audit] = await Promise.all([
      this.tx.financialTransaction.findFirst({ where: { organizationId: this.organizationId, id: transactionId }, select: { id: true, organizationId: true, createdBy: true, occurredAt: true, sealed: true, reversesTransactionId: true } }),
      this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, resourceType: "financial_transaction", resourceId: transactionId, action: "finance.guest_deposit.received" }, orderBy: { id: "asc" }, select: { id: true, actorId: true, after: true, reason: true } }),
    ]);
    return transaction && audit ? { transaction, audit } : null;
  }
  actor(id: string) { return this.tx.userAccount.findFirst({ where: { organizationId: this.organizationId, id }, select: { id: true, organizationId: true, personId: true } }); }
  booking(id: string) { return this.tx.reservation.findFirst({ where: { organizationId: this.organizationId, id }, select: { id: true, organizationId: true, propertyId: true, guestId: true, source: true } }); }
  financialSnapshot(reservationId: string, originalId?: string) {
    return this.tx.reservationFinancialSnapshot.findFirst({ where: { organizationId: this.organizationId, reservationId, ...originalId ? { id: originalId } : {} }, orderBy: { version: "desc" }, select: { id: true, organizationId: true, reservationId: true, version: true, rules: true } });
  }
  async deferGuards() { await this.tx.$executeRaw`SET CONSTRAINTS guest_payment_receipt_native_guard, guest_payment_owner_native_guard DEFERRED`; }
  async flushGuards() { await this.tx.$executeRaw`SET CONSTRAINTS guest_payment_receipt_native_guard, guest_payment_owner_native_guard IMMEDIATE`; }
  async retain(data: GuestPaymentProvenance) {
    const row = await this.tx.guestPaymentReceipt.create({ data: { organizationId: this.organizationId, transactionId: data.transactionId,
      originalAuditId: data.originalAuditId, depositId: data.depositId, operation: data.operation, reservationId: data.booking.reservationId, propertyId: data.booking.propertyId, guestId: data.booking.guestId,
      financialSnapshotId: data.booking.financialSnapshotId, accountId: data.accountId, liabilityAccountId: data.claim.liabilityAccountId,
      collectorUserAccountId: data.collectedBy.userAccountId, collectorPersonId: data.collectedBy.personId, createdBy: data.recordedBy.userAccountId, recordedPersonId: data.recordedBy.personId,
      originalCollectionId: data.originalCollectionId, amount: data.amount.amount, currency: data.amount.currency, receivedAt: new Date(data.receivedAt),
      provenance: JSON.parse(JSON.stringify(data)) as Prisma.InputJsonObject } });
    await this.tx.guestPaymentReceiptOwner.createMany({ data: data.relatedOwners.map((owner, ordinal) => ({ organizationId: this.organizationId, receiptId: row.id, ownerId: owner.ownerId, shareBps: owner.shareBps, ordinal })) });
    return row;
  }
}
