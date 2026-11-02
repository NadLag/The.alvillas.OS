import {z} from "zod";

export const receivableExportPolicyKey="finance.receivable_exports";
export const receivableExportPolicySchema=z.object({
 source:z.literal("CURRENT_ORIGINAL_AGING"),
 format:z.literal("CSV"),
 rate_limit:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict();
