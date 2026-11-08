import {z} from "zod";
import {leadCaptureInputSchema,leadFieldsSchema,leadCaptureMaximumRequestBytes,parseConfiguredLeadDetails,LeadValidationError,type LeadCaptureInput} from "./lead-capture";
import {leadStageReasonSchema} from "./lead-pipeline";

const uuid=z.uuid().transform(value=>value.toLowerCase());
export const leadProfilePolicyKey="crm.lead_profile";
export const leadProfilePolicySchema=z.object({
  source:z.literal("NATIVE_IMMUTABLE_LEAD_PROFILE"),history:z.literal("APPEND_ONLY_REVIEWED_PROFILE_CORRECTIONS"),
  admission:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict();
export type LeadProfilePolicy=z.infer<typeof leadProfilePolicySchema>;
export const leadProfileDraftSchema=z.object({
  leadId:uuid,previousRevisionId:uuid.nullable(),sourceKey:leadCaptureInputSchema.shape.sourceKey,
  locale:leadCaptureInputSchema.shape.locale,fields:leadFieldsSchema
}).strict();
export const leadProfileCommandSchema=leadProfileDraftSchema.extend({
  idempotencyKey:uuid,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:leadStageReasonSchema
}).strict();
export type LeadProfileDraft=z.infer<typeof leadProfileDraftSchema>;
export type LeadProfileCommand=z.infer<typeof leadProfileCommandSchema>;

function bounded<T>(value:T):T{
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>leadCaptureMaximumRequestBytes)throw new LeadValidationError();return value;
}
/** Stable explicit projection protects exact replay from JavaScript property order. */
export function canonicalLeadProfileDraft(raw:unknown):LeadProfileDraft{
  const value=leadProfileDraftSchema.parse(raw),fields=leadFieldsSchema.parse(value.fields);
  if(fields.currentOtaKeys)fields.currentOtaKeys=[...fields.currentOtaKeys].sort();
  return bounded({leadId:value.leadId,previousRevisionId:value.previousRevisionId,sourceKey:value.sourceKey,locale:value.locale,fields});
}
export function canonicalLeadProfileCommand(raw:unknown):LeadProfileCommand{
  const value=leadProfileCommandSchema.parse(raw);
  return bounded({...canonicalLeadProfileDraft({leadId:value.leadId,previousRevisionId:value.previousRevisionId,sourceKey:value.sourceKey,locale:value.locale,fields:value.fields}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason});
}
export function configuredLeadProfile(raw:unknown,originalChannel:LeadCaptureInput["channel"],capturePolicy:unknown):LeadProfileDraft{
  const value=canonicalLeadProfileDraft(raw);parseConfiguredLeadDetails({channel:originalChannel,sourceKey:value.sourceKey,fields:value.fields},capturePolicy);return value;
}
export class LeadProfileConflictError extends Error{constructor(){super("lead_profile_changed");}}
