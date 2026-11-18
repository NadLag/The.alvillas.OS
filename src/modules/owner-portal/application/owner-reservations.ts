import { z } from "zod";
import { calendarDateAt } from "@/i18n/format";
import { authorize } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { reservationStateSchema } from "@/platform/reservations/lifecycle-contract";
import { OwnerPortalRepository } from "../infrastructure/owner-portal-repository";
import type { OwnerPortalActorContext } from "./owner-portal-access";
import { OwnerPortalNotFoundError } from "./owner-portal-service";

const visibleStatus = {
  IMPORTED: "SCHEDULED", CONFIRMED: "CONFIRMED", GUEST_PREPARATION: "CONFIRMED",
  CHECKED_IN: "IN_STAY", STAYING: "IN_STAY", CHECKED_OUT: "COMPLETE",
  FINANCIAL_RECONCILIATION: "COMPLETE", CLOSED: "COMPLETE", CANCELLED: "CANCELLED", NO_SHOW: "NO_SHOW"
} as const;

export const ownerReservationQuery = z.strictObject({
  propertyId: z.uuid(), from: z.iso.date().optional(), until: z.iso.date().optional(),
  cursorDay: z.iso.date().optional(), cursorId: z.uuid().optional(), reservationId: z.uuid().optional()
}).refine(input => Boolean(input.cursorDay) === Boolean(input.cursorId) && (!input.from || !input.until || input.until >= input.from));

export async function listOwnerReservations(ctx: OwnerPortalActorContext, raw: unknown, db: TenantTransactionRunner = prisma) {
  const input = ownerReservationQuery.parse(raw);
  if (!authorize(ctx.authContext, "view", { type: "owner_portal_property", organizationId: ctx.organizationId, id: input.propertyId }))
    throw new OwnerPortalNotFoundError();
  const utc = (day: string) => new Date(day + "T00:00:00.000Z");
  return withTenant(db, ctx.organizationId, async tx => {
    const repository = new OwnerPortalRepository(tx, ctx.organizationId);
    const property = await repository.findOwnerPropertyAccess(ctx.actorId, input.propertyId);
    const calendar = property ? await repository.reservationCalendar(input.propertyId) : null;
    if (!property || !calendar) throw new OwnerPortalNotFoundError();
    const from = input.from ?? calendarDateAt(calendar.now, calendar.timezone);
    if (input.until && input.until < from) throw new RangeError("Invalid reservation calendar range");
    const rows = await repository.reservations(input.propertyId, utc(from), input.until ? utc(input.until) : undefined,
      input.cursorDay && input.cursorId ? { day: utc(input.cursorDay), id: input.cursorId } : undefined, input.reservationId);
    if (!await repository.findOwnerPropertyAccess(ctx.actorId, input.propertyId)) throw new OwnerPortalNotFoundError();
    const day = (value: Date) => value.toISOString().slice(0, 10);
    const cursor = rows.length > 30 ? { cursorDay: day(rows[29].checkIn), cursorId: rows[29].id } : undefined;
    return { propertyName: property.propertyName, propertyId: property.propertyId, from, until: input.until, cursor,
      reservations: rows.slice(0, 30).map(row => {
        const status = reservationStateSchema.safeParse(row.status);
        return { reference: row.reference, checkIn: day(row.checkIn), checkOut: day(row.checkOut), status: status.success ? visibleStatus[status.data] : "OTHER" as const };
      }) };
  });
}
