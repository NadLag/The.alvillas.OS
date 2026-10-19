import { z } from "zod";
export const reservationSourceSchema = z.enum(["MANUAL", "DIRECT", "AGENCY", "AIRBNB", "BOOKING", "VRBO"]);

export const stayDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
export const reservationStates = ["IMPORTED", "CONFIRMED", "GUEST_PREPARATION", "CHECKED_IN", "STAYING", "CHECKED_OUT", "FINANCIAL_RECONCILIATION", "CLOSED", "CANCELLED", "NO_SHOW"] as const;
export const reservationStateSchema = z.enum(reservationStates);
export type ReservationState = z.infer<typeof reservationStateSchema>;
export const terminalStates = ["CANCELLED", "NO_SHOW", "CLOSED"];
export function canTransition(from: string, to: string): boolean {
  const next: Record<string, readonly string[]> = {
    IMPORTED: ["CONFIRMED", "CANCELLED"], CONFIRMED: ["GUEST_PREPARATION", "CANCELLED", "NO_SHOW"],
    GUEST_PREPARATION: ["CHECKED_IN", "CANCELLED", "NO_SHOW"], CHECKED_IN: ["STAYING", "CHECKED_OUT"],
    STAYING: ["CHECKED_OUT"], CHECKED_OUT: ["FINANCIAL_RECONCILIATION"], FINANCIAL_RECONCILIATION: ["CLOSED"]
  };
  return next[from]?.includes(to) ?? false;
}
export const quoteSchema = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/u), currency: z.string().regex(/^[A-Z]{3}$/u) });
export const normalizedReservationSchema = z.object({
  kind: z.enum(["reservation", "block"]), source: reservationSourceSchema,
  initialState: z.enum(["IMPORTED", "CONFIRMED"]).default("CONFIRMED"),
  externalId: z.string().trim().min(1).max(500).nullable(),
  checkIn: stayDateSchema, checkOut: stayDateSchema,
  guestName: z.string().trim().min(1).max(160).nullable().default(null),
  guestEmail: z.email().max(320).nullable().default(null), guestPhone: z.string().max(40).nullable().default(null),
  adultCount: z.number().int().min(0).max(1000).nullable().default(null), childCount: z.number().int().min(0).max(1000).nullable().default(null),
  cancelled: z.boolean().default(false), quote: quoteSchema.nullable().default(null),
  sequence: z.number().int().min(0).nullable().default(null)
}).refine(value => value.checkOut > value.checkIn, { path: ["checkOut"], message: "invalid_stay" });
export type NormalizedReservation = z.infer<typeof normalizedReservationSchema>;
export const reservationSyncPolicyKey = "reservation.sync_policy";
export const reservationSyncPolicySchema = z.object({
  interval_minutes: z.number().int().min(1).max(1440), missing_uid_runs: z.number().int().min(1).max(100),
  stale_after_minutes: z.number().int().min(1).max(10080)
}).strict();
export const feedInputSchema = z.object({ propertyId: z.uuid(), source: z.enum(["AIRBNB", "BOOKING", "VRBO"]), name: z.string().trim().min(1).max(120), url: z.url().max(2000), idempotencyKey: z.uuid() });
export const reservationImportSchema = z.object({ propertyId: z.uuid(), source: reservationSourceSchema, csv: z.string().min(1).max(2_000_000), dateFormat: z.enum(["ISO", "MDY", "DMY"]).default("ISO"), idempotencyKey: z.uuid() });
export const changeReservationSchema = z.object({
  reservationId: z.uuid(), expectedVersion: z.coerce.number().int().min(1), idempotencyKey: z.string().min(1).max(1000),
  reason: z.string().trim().min(3).max(1000), operation: z.enum(["MODIFY", "TRANSITION", "EARLY_CHECKOUT", "REFUND"]),
  status: reservationStateSchema.optional(), checkIn: stayDateSchema.optional(), checkOut: stayDateSchema.optional(),
  guestName: z.string().trim().min(1).max(160).optional(), guestEmail: z.email().max(320).optional(),
  quote: quoteSchema.optional()
}).superRefine((value, ctx) => {
  if (value.operation === "TRANSITION" && !value.status) ctx.addIssue({ code: "custom", path: ["status"], message: "required" });
  if (value.operation === "EARLY_CHECKOUT" && !value.checkOut) ctx.addIssue({ code: "custom", path: ["checkOut"], message: "required" });
});
export const blockInputSchema = z.object({ propertyId: z.uuid(), kind: z.enum(["OWNER", "MAINTENANCE"]), checkIn: stayDateSchema, checkOut: stayDateSchema, reason: z.string().trim().min(3).max(500), idempotencyKey: z.uuid() }).refine(value => value.checkOut > value.checkIn);
export const calendarQuerySchema = z.object({ start: stayDateSchema, end: stayDateSchema, propertyId: z.uuid().optional(), page: z.coerce.number().int().min(1).default(1), feedPage: z.coerce.number().int().min(1).default(1) }).refine(v => v.end > v.start && (Date.parse(v.end) - Date.parse(v.start)) / 86400000 <= 93);
export function sameGuest(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left.normalize("NFKC").trim().toLocaleLowerCase() === right.normalize("NFKC").trim().toLocaleLowerCase());
}
export function localDate(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function reservationFormValues(data: FormData): Record<string, unknown> {
  const values: Record<string, unknown> = Object.fromEntries(data);
  if (values.amount) values.quote = { amount: values.amount, currency: values.currency };
  for (const key of ["checkIn", "checkOut", "guestName", "guestEmail", "status"]) if (values[key] === "") delete values[key];
  return values;
}
