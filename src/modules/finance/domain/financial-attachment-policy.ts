import { z } from "zod";
import { financialAttachmentContentTypes } from "./financial-attachment";

export const financialAttachmentPolicyKey = "finance.transaction_attachments";
export const financialAttachmentPolicySchema = z.object({ source: z.literal("ORIGINAL_SEALED_FINANCIAL_TRANSACTION"),
  content_types: z.array(z.enum(financialAttachmentContentTypes)).min(1).max(financialAttachmentContentTypes.length).refine(values => new Set(values).size === values.length),
  max_bytes: z.number().int().positive().max(50 * 1024 * 1024), intent_lifetime_seconds: z.number().int().positive().max(86400),
  storage_read_ttl_seconds: z.number().int().min(30).max(300), encryption: z.literal("APP_MANAGED_AUTHENTICATED_ENCRYPTION"),
  history: z.literal("APPEND_ONLY_WITH_RETAINED_SUPERSEDED_FILES"), rate_limit: z.object({ requests: z.number().int().positive().max(2147483647),
    window_seconds: z.number().int().positive().max(2147483647) }).strict() }).strict();
export type FinancialAttachmentPolicy = z.infer<typeof financialAttachmentPolicySchema>;
