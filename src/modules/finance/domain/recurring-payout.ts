import {z} from "zod";
export const recurringPayoutPolicyKey="finance.recurring_payouts";
/** Dates and amounts come from the actual approved payout and its frozen agreement policy. */
export const recurringPayoutPolicySchema=z.object({
 source:z.literal("CURRENT_APPROVED_OWNER_PAYOUTS"),principal:z.literal("CURRENT_CONFIGURATION_AUTHOR"),
 schedule:z.literal("FROZEN_APPROVED_ELIGIBILITY"),batch_size:z.number().int().min(1).max(500)
}).strict();
export class RecurringPayoutPolicyError extends Error{}
