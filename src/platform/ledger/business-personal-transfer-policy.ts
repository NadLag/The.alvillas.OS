import { z } from "zod";

export const businessPersonalTransferPolicyKey = "finance.business_personal_transfers";
export const businessPersonalTransferPolicySchema = z.object({
  approval_reference: z.string().trim().min(1).max(240),
  categories: z.array(z.object({
    category: z.string().trim().min(1).max(80),
    cash_account_code: z.string().trim().min(1).max(120),
    company_account_code: z.string().trim().min(1).max(120)
  }).strict().refine((row) => row.cash_account_code !== row.company_account_code)).min(1).max(100)
}).strict().refine(({ categories }) => new Set(categories.map((row) => row.category)).size === categories.length);
