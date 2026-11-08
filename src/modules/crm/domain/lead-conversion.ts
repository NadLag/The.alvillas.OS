import {z} from "zod";
import {leadStageReasonSchema} from "./lead-pipeline";

export const leadConversionPolicyKey="crm.lead_conversion";
export const leadConversionPolicySchema=z.object({
  source:z.literal("NATIVE_REVIEWED_LEAD_OWNER_CONVERSION"),
  history:z.literal("APPEND_ONLY_ORIGINAL_CONVERSION"),
  prerequisite:z.literal("NATIVE_SIGNED_STAGE_AND_COMPLETED_ARCHIVE"),
  modes:z.array(z.enum(["CREATE","LINK"])).min(1).max(2).refine(values=>new Set(values).size===values.length),
  admission:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict();
const uuid=z.uuid().transform(value=>value.toLowerCase());
const sha256=z.string().regex(/^[a-f0-9]{64}$/u);
export const leadConversionTargetSchema=z.discriminatedUnion("mode",[
  z.object({mode:z.literal("CREATE")}).strict(),
  z.object({mode:z.literal("LINK"),ownerId:uuid}).strict()
]);
export const leadConversionDraftSchema=z.object({leadId:uuid,profileRevisionId:uuid.nullable(),signedStageId:uuid,target:leadConversionTargetSchema}).strict();
export const leadConversionCommandSchema=leadConversionDraftSchema.extend({idempotencyKey:uuid,reviewFingerprint:sha256,reason:leadStageReasonSchema}).strict();
export type LeadConversionDraft=z.infer<typeof leadConversionDraftSchema>;
export type LeadConversionCommand=z.infer<typeof leadConversionCommandSchema>;
export const leadConversionOwnerSchema=z.object({displayName:z.string(),email:z.string().nullable(),phone:z.string().nullable(),preferredLocale:z.enum(["en","fr","ar"])}).strict();
export const leadConversionReceiptSchema=z.object({id:uuid,leadId:uuid,ownerId:uuid,mode:z.enum(["CREATE","LINK"]),profileRevisionId:uuid.nullable(),signedStageId:uuid,signedArchiveId:uuid,sourceKey:z.string(),locale:z.enum(["en","fr","ar"]),createdAt:z.iso.datetime(),replayed:z.boolean()}).strict();
export const leadConversionReviewSchema=leadConversionDraftSchema.extend({reviewFingerprint:sha256,owner:leadConversionOwnerSchema});
export const leadConversionReadSchema=z.object({conversion:leadConversionReceiptSchema.nullable(),originalOwner:leadConversionOwnerSchema.optional(),reason:z.string().optional()}).strict();
export const leadConversionOptionsSchema=z.object({leadId:uuid,profileRevisionId:uuid.nullable(),signedStageId:uuid.nullable(),modes:z.array(z.enum(["CREATE","LINK"])).max(2),converted:z.boolean()}).strict();
export const leadConversionChoicesSchema=z.object({owners:z.array(z.object({id:uuid,displayName:z.string(),email:z.string().nullable()}).strict()).max(20),next:z.string().nullable()}).strict();
export function canonicalLeadConversionDraft(raw:unknown):LeadConversionDraft{
  const value=leadConversionDraftSchema.parse(raw);
  return{leadId:value.leadId,profileRevisionId:value.profileRevisionId,signedStageId:value.signedStageId,target:value.target.mode==="CREATE"?{mode:"CREATE"}:{mode:"LINK",ownerId:value.target.ownerId}};
}
export function canonicalLeadConversionCommand(raw:unknown):LeadConversionCommand{
  const value=leadConversionCommandSchema.parse(raw);
  return{...canonicalLeadConversionDraft({leadId:value.leadId,profileRevisionId:value.profileRevisionId,signedStageId:value.signedStageId,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
/** A conversion never accepts copied contact data, money, a signature flag or an Owner overwrite. */
export class LeadConversionConflictError extends Error{constructor(){super("lead_conversion_changed");}}
export class LeadConversionSourceError extends Error{constructor(){super("lead_conversion_source_fields");}}
