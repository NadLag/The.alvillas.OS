import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { configSlugSchema } from "@/platform/config/identifiers";

export const leadCaptureChannels = ["WEBSITE", "MANUAL", "REFERRAL"] as const;
export const leadCapturePolicyKey = "crm.lead_capture";
export const leadCaptureMaximumRequestBytes = 32768;

const text = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine(value => !/\p{Cc}/u.test(value.replaceAll("\t", "").replaceAll("\n", "").replaceAll("\r", "")))
  .transform(value => value.normalize("NFC"));
const contact = z.object({
  name: text(240), phone: text(80).optional(), email: z.email().max(320).optional()
}).strict();

/** Claimed acquisition details never identify or modify an existing private person or owner. */
export const leadFieldsSchema = z.object({
  ownerContact: text(240),
  phone: text(80).optional(),
  email: z.email().max(320).optional(),
  location: text(1000).optional(),
  propertyTypeKey: configSlugSchema.optional(),
  bedrooms: z.number().int().min(0).max(2147483647).optional(),
  currentRentalStatusKey: configSlugSchema.optional(),
  currentOtaKeys: z.array(configSlugSchema).max(100).refine(values => new Set(values).size === values.length).optional(),
  objectives: text(8000).optional(),
  notes: text(8000).optional(),
  referralContact: contact.optional()
}).strict();

export const leadRequiredFieldKeys = [
  "phone", "email", "location", "propertyTypeKey", "bedrooms", "currentRentalStatusKey", "currentOtaKeys", "objectives", "notes"
] as const;
const distinct = <T,>(values: T[]) => new Set(values).size === values.length;
const rateLimit = z.object({
  requests: z.number().int().positive().max(2147483647),
  window_seconds: z.number().int().positive().max(2147483647)
}).strict();
const catalog = z.array(z.object({key: configSlugSchema, label: localizedTextSchema}).strict())
  .max(1000).refine(values => distinct(values.map(value => value.key)));

/** Activation requires an owner-approved processing reference; this supplies no legal defaults. */
export const leadCapturePolicySchema = z.object({
  source: z.literal("NATIVE_PRIVATE_LEAD_CAPTURE"),
  channels: z.array(z.enum(leadCaptureChannels)).min(1).max(3).refine(distinct),
  sources: z.array(z.object({
    key: configSlugSchema, label: localizedTextSchema,
    channels: z.array(z.enum(leadCaptureChannels)).min(1).max(3).refine(distinct)
  }).strict()).min(1).max(1000).refine(values => distinct(values.map(value => value.key))),
  required_fields: z.array(z.enum(leadRequiredFieldKeys)).max(leadRequiredFieldKeys.length).refine(distinct),
  contact_requirement: z.enum(["PHONE", "EMAIL", "PHONE_OR_EMAIL", "PHONE_AND_EMAIL"]),
  property_types: catalog,
  rental_statuses: catalog,
  otas: catalog,
  processing_approval_reference: text(1000),
  website_notice: z.object({
    approval_reference: text(1000), notice_sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict().nullable(),
  encryption: z.literal("APP_MANAGED_AUTHENTICATED_ENCRYPTION"),
  history: z.literal("APPEND_ONLY_ORIGINAL_CAPTURE"),
  rate_limit: rateLimit
}).strict().superRefine((value, ctx) => {
  if (value.channels.includes("WEBSITE") && !value.website_notice)
    ctx.addIssue({code:"custom",path:["website_notice"],message:"approved_website_notice_required"});
  for (const [index, source] of value.sources.entries())
    if (source.channels.some(channel => !value.channels.includes(channel)))
      ctx.addIssue({code:"custom",path:["sources",index,"channels"],message:"enabled_capture_channel_required"});
});

export const leadCaptureInputSchema = z.object({
  idempotencyKey: z.uuid(), channel: z.enum(leadCaptureChannels), sourceKey: configSlugSchema,
  locale: z.enum(["en", "fr", "ar"]), fields: leadFieldsSchema,
  websiteAcknowledgement: z.object({
    approvalReference: text(1000), noticeSha256: z.string().regex(/^[a-f0-9]{64}$/u), affirmed: z.literal(true)
  }).strict().optional()
}).strict();

export type LeadCaptureInput = z.infer<typeof leadCaptureInputSchema>;
export type LeadCapturePolicy = z.infer<typeof leadCapturePolicySchema>;

export function parseConfiguredLeadCapture(input: unknown, policyInput: unknown): LeadCaptureInput {
  const policy = leadCapturePolicySchema.parse(policyInput), value = leadCaptureInputSchema.parse(input);
  const source = policy.sources.find(item => item.key === value.sourceKey);
  if (!policy.channels.includes(value.channel) || !source?.channels.includes(value.channel)) throw new LeadValidationError();
  for (const field of policy.required_fields) {
    const item = value.fields[field];
    if (item === undefined || (Array.isArray(item) && item.length === 0)) throw new LeadValidationError();
  }
  const {phone,email} = value.fields;
  if ((policy.contact_requirement === "PHONE" && !phone) || (policy.contact_requirement === "EMAIL" && !email) ||
    (policy.contact_requirement === "PHONE_OR_EMAIL" && !phone && !email) ||
    (policy.contact_requirement === "PHONE_AND_EMAIL" && (!phone || !email))) throw new LeadValidationError();
  const allowed = (key: string | undefined, entries: Array<{key:string}>) => key === undefined || entries.some(item => item.key === key);
  if (!allowed(value.fields.propertyTypeKey,policy.property_types) || !allowed(value.fields.currentRentalStatusKey,policy.rental_statuses) ||
    value.fields.currentOtaKeys?.some(key => !allowed(key,policy.otas))) throw new LeadValidationError();
  if ((value.channel === "REFERRAL") !== Boolean(value.fields.referralContact)) throw new LeadValidationError();
  const acknowledgement = value.websiteAcknowledgement;
  if (value.channel === "WEBSITE") {
    if (!policy.website_notice || !acknowledgement || acknowledgement.approvalReference !== policy.website_notice.approval_reference ||
      acknowledgement.noticeSha256 !== policy.website_notice.notice_sha256) throw new LeadValidationError();
  } else if (acknowledgement) throw new LeadValidationError();
  return value;
}

export class LeadValidationError extends Error { constructor(){super("lead_validation");} }
export class LeadAccessError extends Error { constructor(){super("lead_unavailable");} }
export class LeadConfigurationError extends Error { constructor(){super("lead_configuration_unavailable");} }
export class LeadConflictError extends Error { constructor(){super("lead_command_conflict");} }
export class LeadRateLimitError extends Error { constructor(readonly resetAt:Date){super("lead_rate_limited");} }
