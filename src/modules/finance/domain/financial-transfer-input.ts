import {z} from "zod";
import Decimal from "decimal.js";

export const financialTransferKinds = ["TRANSFER", "ADVANCE", "RETURN"] as const;
export const financialTransferSchema = z.object({
  fromAccountId: z.uuid().transform(value=>value.toLowerCase()), toAccountId: z.uuid().transform(value=>value.toLowerCase()),
  kind: z.enum(financialTransferKinds), amount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u)
    .pipe(z.string().refine(value=>new Decimal(value).gt(0)).transform(value=>new Decimal(value).toFixed(2))),
  currency: z.string().regex(/^[A-Z]{3}$/u), purpose: z.string().trim().min(3).max(500),
  reason: z.string().trim().min(6).max(500), idempotencyKey: z.uuid().transform(value=>value.toLowerCase())
}).strict().refine(value=>value.fromAccountId!==value.toAccountId,{path:["toAccountId"],message:"Distinct accounts required"});
export type FinancialTransferInput = z.infer<typeof financialTransferSchema>;
