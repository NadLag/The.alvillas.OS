import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {optionalGuestPhoneSchema} from "@/platform/notifications/whatsapp";

export const guestHubProfilePolicyKey="guest_hub.profile";
export const guestHubProfileFieldSchema=z.enum(["displayName","email","phone","preferredLocale"]);
export type GuestHubProfileField=z.infer<typeof guestHubProfileFieldSchema>;
const text=z.string().trim().min(1).max(1000).refine(value=>!/[\p{Cc}]/u.test(value));
const fields=z.array(guestHubProfileFieldSchema).min(1).max(4).refine(value=>new Set(value).size===value.length);
export const guestHubProfileNoticeSchema=z.object({reference:text,title:localizedTextSchema.strict(),paragraphs:z.array(localizedTextSchema.strict()).min(1).max(30)}).strict();
export const guestHubProfilePolicySchema=z.object({
 source:z.literal("NATIVE_RESERVATION_GUEST_PROFILE"),history:z.literal("APPEND_ONLY_RESERVATION_PROFILE"),enabled:z.boolean(),
 processing_approval_reference:text.nullable(),notice:guestHubProfileNoticeSchema.nullable(),require_acknowledgement:z.boolean(),
 allowed_fields:fields,required_fields:z.array(guestHubProfileFieldSchema).max(4).refine(value=>new Set(value).size===value.length),
 submissions:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict().superRefine((value,context)=>{
 if(value.enabled&&(!value.processing_approval_reference||!value.notice))context.addIssue({code:"custom",path:["processing_approval_reference"],message:"explicit_guest_profile_processing_and_notice_required"});
 if(value.required_fields.some(field=>!value.allowed_fields.includes(field)))context.addIssue({code:"custom",path:["required_fields"],message:"required_profile_fields_must_be_explicitly_allowed"});
});
export type GuestHubProfilePolicy=z.infer<typeof guestHubProfilePolicySchema>;
const nullableText=(maximum:number)=>z.preprocess(value=>typeof value==="string"&&!value.trim()?null:value,z.string().trim().min(1).max(maximum).refine(value=>!/[\p{Cc}]/u.test(value)).nullable()).optional();
export const guestHubProfileValuesSchema=z.object({displayName:nullableText(200),email:z.preprocess(value=>typeof value==="string"&&!value.trim()?null:value,z.string().trim().toLowerCase().max(254).email().nullable()).optional(),phone:z.preprocess(value=>typeof value==="string"&&!value.trim()?null:value,optionalGuestPhoneSchema.nullable()).optional(),preferredLocale:z.enum(["en","fr","ar"]).nullable().optional()}).strict();
export type GuestHubProfileValues=z.infer<typeof guestHubProfileValuesSchema>;
export class GuestHubProfileAccessError extends Error{constructor(){super("guest_profile_access_unavailable");}}
export class GuestHubProfileConflictError extends Error{constructor(){super("guest_profile_review_changed");}}
export class GuestHubProfileConfigurationError extends Error{constructor(){super("guest_profile_configuration_unavailable");}}

/** A new policy cannot silently broaden a previously granted form or repurpose its notice. */
export function effectiveGuestHubProfilePolicy(captured:GuestHubProfilePolicy,current:GuestHubProfilePolicy){
 const original=guestHubProfilePolicySchema.parse(captured),latest=guestHubProfilePolicySchema.parse(current);
 if(!original.enabled||!latest.enabled||!original.processing_approval_reference||original.processing_approval_reference!==latest.processing_approval_reference||!original.notice||JSON.stringify(original.notice)!==JSON.stringify(latest.notice))throw new GuestHubProfileAccessError();
 const allowed=original.allowed_fields.filter(field=>latest.allowed_fields.includes(field)),required=[...new Set([...original.required_fields,...latest.required_fields])];
 if(!allowed.length||required.some(field=>!allowed.includes(field)))throw new GuestHubProfileAccessError();
 return{allowed,required,notice:latest.notice,requireAcknowledgement:original.require_acknowledgement||latest.require_acknowledgement,limits:[original.submissions,latest.submissions]};
}
export function validateGuestHubProfileValues(raw:unknown,policy:ReturnType<typeof effectiveGuestHubProfilePolicy>,acknowledged:boolean){
 const value=guestHubProfileValuesSchema.parse(raw);if(Object.keys(value).some(field=>!policy.allowed.includes(guestHubProfileFieldSchema.parse(field)))||policy.required.some(field=>value[field]==null)||policy.requireAcknowledgement&&!acknowledged)throw new GuestHubProfileAccessError();return value;
}
/** Field withdrawal and explicit nulls stay authoritative; only absent fields may reuse the native source. */
export function presentGuestHubProfileValues(source:unknown,latest:GuestHubProfileValues|null,allowed:readonly GuestHubProfileField[]){
 const canonical=z.object({displayName:z.unknown().optional(),email:z.unknown().optional(),phone:z.unknown().optional(),preferredLocale:z.unknown().optional()}).strict().parse(source),revision=latest?guestHubProfileValuesSchema.parse(latest):null,result:Record<string,string|null>={};
 for(const field of allowed){if(revision&&Object.hasOwn(revision,field)){const value=revision[field];if(value!==undefined)result[field]=value;}else{const parsed=guestHubProfileValuesSchema.shape[field].safeParse(canonical[field]);if(parsed.success&&parsed.data!==undefined)result[field]=parsed.data;else if(canonical[field]!==undefined)result[field]=null;}}
 return guestHubProfileValuesSchema.parse(result);
}
