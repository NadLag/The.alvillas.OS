import { z } from "zod";

export const documentArchivePolicyKey = "documents.archive";
export const documentSourceKinds = ["ORGANIZATION", "PROPERTY", "OWNER", "RESERVATION", "PERSON", "FINANCIAL_TRANSACTION"] as const;
export const documentPrivacyTags = ["operational", "sensitive", "financial"] as const;
export const documentContentTypes = ["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/json", "text/plain"] as const;
const labels = z.object({ en: z.string().trim().min(1).max(160), fr: z.string().trim().min(1).max(160), ar: z.string().trim().min(1).max(160) }).strict();
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
export const documentTypePolicySchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u), labels,
  sources: z.array(z.enum(documentSourceKinds)).nonempty().refine(unique), privacy: z.array(z.enum(documentPrivacyTags)).nonempty().refine(unique),
  content_types: z.array(z.enum(documentContentTypes)).nonempty().refine(unique), max_bytes: z.number().int().min(1).max(10 * 1024 * 1024)
}).strict().superRefine((value, ctx) => {
  if (value.sources.includes("FINANCIAL_TRANSACTION") && !value.privacy.includes("financial")) ctx.addIssue({ code: "custom", message: "financial_source_requires_financial_privacy" });
  if (value.sources.includes("PERSON") && !value.privacy.includes("sensitive")) ctx.addIssue({ code: "custom", message: "person_source_requires_sensitive_privacy" });
});
export const documentArchivePolicySchema = z.object({ source: z.literal("NATIVE_DOCUMENT_ARCHIVE"), types: z.array(documentTypePolicySchema).nonempty().refine(values => unique(values.map(value => value.key))),
  encryption: z.literal("APP_MANAGED_AEAD"), history: z.literal("APPEND_ONLY"), downloads: z.literal("AUTHORIZED_SERVER_PROXY"),
  upload_admission: z.object({ window_seconds: z.number().int().min(1).max(86400), max_requests: z.number().int().min(1).max(10000) }).strict(),
  storage_url_seconds: z.number().int().min(1).max(300)
}).strict();
export type DocumentArchivePolicy = z.infer<typeof documentArchivePolicySchema>;
export type DocumentTypePolicy = z.infer<typeof documentTypePolicySchema>;

/** A later version or configuration change can add protection, never remove it. */
export function retainDocumentPrivacy(existing: readonly string[], required: readonly string[], source: typeof documentSourceKinds[number]) {
  const values = z.array(z.enum(documentPrivacyTags)).parse([...existing, ...required, ...(source === "FINANCIAL_TRANSACTION" ? ["financial"] : source === "PERSON" ? ["sensitive"] : [])]);
  return [...new Set(values)].sort();
}
