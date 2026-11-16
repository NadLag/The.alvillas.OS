import {z} from "zod";

export const serviceOrderPolicyKey="services.ordering";
/** Limits and request semantics are explicit configuration, without a
 * production quantity, duration, scheduling or cancellation-fee default. */
export const serviceOrderPolicySchema=z.object({
 schemaVersion:z.literal(1),
 max_quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 max_service_days:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 participant_basis:z.literal("SELECTED_RESERVATION_GUESTS"),
 date_basis:z.literal("INCLUSIVE_RESERVATION_DATES")
}).strict();
export type ServiceOrderPolicy=z.infer<typeof serviceOrderPolicySchema>;
