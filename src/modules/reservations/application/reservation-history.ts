import type { TenantTransaction } from "@/platform/db/tenant";
import type { ReservationActorContext } from "./reservation-access";
import type { ReservationAuditMeta } from "./reservation-service";
import type { ReservationSummary } from "../domain/reservation-task";
import type { NormalizedReservation } from "../domain/reservation";
import { ReservationRepository } from "../infrastructure/reservation-repository";
import { captureReservationCommissionSnapshots } from "@/platform/reservations/finance";
import { writeAuditEvent } from "@/platform/audit/audit-writer";

export async function captureConfirmation(tx: TenantTransaction, ctx: ReservationActorContext, reservationId: string, quote: NormalizedReservation["quote"], version: number) {
  const repository = new ReservationRepository(tx, ctx.organizationId);
  const reservation = await repository.reservation(reservationId);
  if (!reservation) throw new Error("reservation_not_found");
  const owners = await captureReservationCommissionSnapshots(tx, ctx.organizationId, reservationId, ctx.actorId);
  const rules = await repository.resolvedFinancialRules(reservation.propertyId, reservation.confirmedAt ?? reservation.createdAt, reservation.source);
  const snapshot = await repository.financialSnapshot(reservationId, version, quote, { rules, owners }, ctx.actorId);
  if (!owners.length || owners.some(owner => owner.configurationMissing)) await repository.exception(reservation.propertyId, reservationId, "FINANCIAL_CONFIGURATION", `financial-config:${reservationId}`, { snapshotId: snapshot.id }, ctx.actorId);
  return snapshot;
}
export async function initializeReservationHistory(tx: TenantTransaction, ctx: ReservationActorContext, reservation: ReservationSummary, guest: Pick<NormalizedReservation, "guestName" | "guestEmail" | "guestPhone">, meta: ReservationAuditMeta, quote: NormalizedReservation["quote"] = null) {
  const repository = new ReservationRepository(tx, ctx.organizationId);
  const record = await repository.guest(guest, ctx.actorId);
  await repository.attachGuest(reservation.id, record.id);
  await repository.appendRevision({ reservationId: reservation.id, version: 1, operation: reservation.status === "IMPORTED" ? "IMPORT" : "CONFIRM", before: {}, after: { ...reservation, guestId: record.id }, reason: "Reservation created and confirmed", idempotencyKey: `created:${reservation.id}`, actorId: ctx.actorId });
  await repository.queueChange(reservation.id, 1, "CONFIRMED");
  if (reservation.status === "IMPORTED") {
    if (quote) await repository.financialSnapshot(reservation.id, 1, quote, { pendingConfirmation: true }, ctx.actorId);
    return;
  }
  const snapshot = await captureConfirmation(tx, ctx, reservation.id, quote, 1);
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "reservation.financial_snapshot.captured", resourceType: "reservation", resourceId: reservation.id, propertyScopeId: reservation.propertyId, after: { snapshotId: snapshot.id, version: 1 }, reason: "Confirmation rules locked", requestId: meta.requestId, ipAddress: meta.ipAddress, occurredAt: new Date() });
}
