import { z } from "zod";

const identity = z.uuid().transform(value => value.toLowerCase());
/** Shared native booking, principal, location and exact Money facts; never current-property inference. */
export const externalPaymentSourceSchema = z.object({ schemaVersion: z.literal(1), organizationId: identity, userAccountId: identity, personId: identity,
  reservationId: identity, propertyId: identity, guestId: identity, bookingSource: z.string().min(1), financialSnapshotId: identity, financialSnapshotVersion: z.number().int().positive(),
  city: z.string(), region: z.string().nullable(), accountId: identity, amount: z.object({ amount: z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict(), receivedAt: z.iso.datetime() }).strict();
