import { z } from "zod";
import { Money } from "@/platform/money/money";
import { personalAmountSchema, personalCurrencySchema } from "./personal-finance";

export const transferRequestSchema = z.object({
  id: z.uuid(), category: z.string().trim().min(1).max(80), amount: personalAmountSchema,
  currency: personalCurrencySchema, effectiveOn: z.iso.date(), direction: z.enum(["TO_PERSONAL", "TO_BUSINESS"])
}).strict().refine((value) => Money.of(value.amount, value.currency).amount.isPositive());

export const transferConfirmationSchema = z.object({ id: z.uuid(), businessTransactionId: z.uuid() }).strict();
