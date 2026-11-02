import {z} from "zod";
import Decimal from "decimal.js";

/** Canonical native expense input, independent of policy resolution and journal modules. */
export const expenseDraftSchema = z.object({
  propertyId: z.uuid(), reservationId: z.uuid().optional(), category: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u),
  amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).pipe(z.string().refine(value => new Decimal(value).gt(0))),
  currency: z.string().regex(/^[A-Z]{3}$/u), purpose: z.string().trim().min(3).max(1000),
  occurredOn: z.iso.date(), fundingAccountId: z.uuid(), emergency: z.boolean().default(false), idempotencyKey: z.uuid(),
  reason: z.string().trim().min(6).max(500)
}).strict();
export type ExpenseDraftInput = z.infer<typeof expenseDraftSchema>;
