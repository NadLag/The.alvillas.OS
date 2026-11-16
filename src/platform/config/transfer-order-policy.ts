import {z} from "zod";

/** Transfer requests describe one pickup. Driver assignment and collected cash
 * remain native task and custody records, independently authorized. */
export const transferOrderTermsSchema=z.object({schemaVersion:z.literal(1),task_type:z.literal("TRANSFER"),cash:z.literal("NATIVE_CASH_CUSTODY")}).strict();
export const transferRequestSchema=z.object({
 pickup:z.string().trim().min(1).max(500),destination:z.string().trim().min(1).max(500),
 pickupTime:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
 flightReference:z.string().trim().min(1).max(100).optional(),instructions:z.string().trim().min(1).max(500).optional()
}).strict();
export type TransferRequest=z.infer<typeof transferRequestSchema>;
