import { z } from "zod";
import { accountantReportKinds, accountantExportFormats } from "./accountant-export";

export const accountantExportPolicyKey = "finance.accountant_exports";
const names = z.array(z.string().trim().min(1).max(120)).min(1).max(1000).refine(values => new Set(values).size === values.length);
const classification = z.object({ buckets: names, account_codes: names.optional(), account_types: z.array(z.enum(["ALVILLAS_OWN", "CLAIM_OWNERSHIP"])).min(1).max(2)
  .refine(values => new Set(values).size === values.length), sides: z.array(z.enum(["DEBIT", "CREDIT"])).min(1).max(2)
  .refine(values => new Set(values).size === values.length) }).strict();
const capacity = z.number().int().positive().max(100000);
export const accountantExportPolicySchema = z.object({
  source: z.literal("ORIGINAL_POSTED_FINANCIAL_SOURCES"),
  reports: z.array(z.enum(accountantReportKinds)).min(1).max(accountantReportKinds.length).refine(values => new Set(values).size === values.length),
  formats: z.array(z.enum(accountantExportFormats)).min(1).max(accountantExportFormats.length).refine(values => new Set(values).size === values.length),
  classifications: z.object({ income: classification.optional(), expenses: classification.optional() }).strict(),
  capacity: z.object({ CSV: capacity, EXCEL: capacity, PDF: capacity }).strict(),
  rate_limit: z.object({ requests: z.number().int().positive().max(2147483647), window_seconds: z.number().int().positive().max(2147483647) }).strict()
}).strict().superRefine((value, ctx) => {
  for (const [kind, key] of [["INCOME", "income"], ["EXPENSES", "expenses"]] as const) if (value.reports.includes(kind) && !value.classifications[key])
    ctx.addIssue({ code: "custom", path: ["classifications", key], message: "explicit_classification_required" });
});
export type AccountantExportPolicy = z.infer<typeof accountantExportPolicySchema>;
