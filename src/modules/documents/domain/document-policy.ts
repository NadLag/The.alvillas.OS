import { z } from "zod";
import { privateUploadSingleRequestBytes } from "@/platform/storage/upload-protocol";
import { documentTemplateMediaType } from "./document-template-format";

export const documentArchivePolicyKey = "documents.archive";
export const documentSourceKinds = ["ORGANIZATION", "PROPERTY", "OWNER", "RESERVATION", "PERSON", "FINANCIAL_TRANSACTION", "SUPPLIER", "GUEST", "LEAD", "ONBOARDING"] as const;
export const documentCategories = ["OWNER_CONTRACT", "AMENDMENT", "GUEST_AGREEMENT", "HOUSE_RULES", "INVOICE", "RECEIPT", "PROPERTY", "SUPPLIER", "STAFF", "REPORT"] as const;
export const documentPrivacyTags = ["operational", "sensitive", "financial"] as const;
export const documentContentTypes = ["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/json", "text/plain", documentTemplateMediaType] as const;
const labels = z.object({ en: z.string().trim().min(1).max(160), fr: z.string().trim().min(1).max(160), ar: z.string().trim().min(1).max(160) }).strict();
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
export const documentTypePolicySchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u), labels,
  category: z.enum(documentCategories).optional(),
  sources: z.array(z.enum(documentSourceKinds)).nonempty().refine(unique), privacy: z.array(z.enum(documentPrivacyTags)).nonempty().refine(unique),
  content_types: z.array(z.enum(documentContentTypes)).nonempty().refine(unique), max_bytes: z.number().int().min(1).max(10 * 1024 * 1024)
}).strict().superRefine((value, ctx) => {
  if (value.sources.includes("FINANCIAL_TRANSACTION") && !value.privacy.includes("financial")) ctx.addIssue({ code: "custom", message: "financial_source_requires_financial_privacy" });
  if (value.sources.includes("PERSON") && !value.privacy.includes("sensitive")) ctx.addIssue({ code: "custom", message: "person_source_requires_sensitive_privacy" });
  if (value.sources.includes("LEAD") && !value.privacy.includes("sensitive")) ctx.addIssue({ code: "custom", message: "lead_source_requires_sensitive_privacy" });
  if (value.sources.includes("ONBOARDING") && (!value.privacy.includes("sensitive")||!value.privacy.includes("financial"))) ctx.addIssue({code:"custom",message:"onboarding_source_requires_financial_and_sensitive_privacy"});
  if (value.sources.some(source => source === "SUPPLIER" || source === "GUEST") && !value.privacy.includes("sensitive")) ctx.addIssue({ code: "custom", message: "party_source_requires_sensitive_privacy" });
  if ((value.category === "INVOICE" || value.category === "RECEIPT") && !value.privacy.includes("financial")) ctx.addIssue({ code: "custom", message: "financial_document_category_requires_financial_privacy" });
  if (["OWNER_CONTRACT", "GUEST_AGREEMENT", "SUPPLIER", "STAFF"].some(category => category === value.category) && !value.privacy.includes("sensitive")) ctx.addIssue({ code: "custom", message: "private_document_category_requires_sensitive_privacy" });
});
export const documentArchivePolicySchema = z.object({ source: z.literal("NATIVE_DOCUMENT_ARCHIVE"), types: z.array(documentTypePolicySchema).nonempty().refine(values => unique(values.map(value => value.key))),
  encryption: z.literal("APP_MANAGED_AEAD"), history: z.literal("APPEND_ONLY"), downloads: z.literal("AUTHORIZED_SERVER_PROXY"),
  upload_admission: z.object({ window_seconds: z.number().int().min(1).max(86400), max_requests: z.number().int().min(1).max(10000) }).strict(),
  upload_transport: z.object({ window_seconds: z.number().int().min(1).max(86400), max_requests: z.number().int().min(1).max(100000) }).strict().optional(),
  storage_url_seconds: z.number().int().min(1).max(300)
}).strict().superRefine((value,ctx)=>{if(value.types.some(type=>type.max_bytes>privateUploadSingleRequestBytes||type.content_types.includes(documentTemplateMediaType))&&!value.upload_transport)ctx.addIssue({code:"custom",message:"explicit_document_transport_budget_required"});});
export type DocumentArchivePolicy = z.infer<typeof documentArchivePolicySchema>;
export type DocumentTypePolicy = z.infer<typeof documentTypePolicySchema>;

/** Classification belongs to the original captured rule, not its current replacement. */
export function retainedDocumentCategory(policySnapshot: unknown, typeKey: string) {
  const original = z.object({ value: z.object({ types: z.array(z.object({ key: z.string(), category: z.enum(documentCategories).optional() })) }) }).parse(policySnapshot);
  const category = original.value.types.find(type => type.key === typeKey)?.category;
  return category ? { category } : {};
}

/** A later version or configuration change can add protection, never remove it. */
export function retainDocumentPrivacy(existing: readonly string[], required: readonly string[], source: typeof documentSourceKinds[number]) {
  const values = z.array(z.enum(documentPrivacyTags)).parse([...existing, ...required, ...(source === "ONBOARDING" ? ["financial","sensitive"] : source === "FINANCIAL_TRANSACTION" ? ["financial"] : ["PERSON", "SUPPLIER", "GUEST", "LEAD"].includes(source) ? ["sensitive"] : [])]);
  return [...new Set(values)].sort();
}
