import {z} from "zod";
import {guestHubFormBudgetSchema,guestHubFormNoticeSchema,guestHubFormReferenceSchema,retainsGuestHubFormPurpose} from "./guest-hub-form-policy";
import type {AppLocale} from "@/i18n/routing";

export const guestHubAgreementPolicyKey="guest_hub.guest_agreement";
const key=z.string().min(1).max(120).regex(/^[a-z][a-z0-9_]*$/u);
const template=z.string().min(1).max(120).regex(/^[a-z][a-z0-9_.-]*$/u);
export const guestHubAgreementPolicySchema=z.object({
 source:z.literal("NATIVE_GENERATED_GUEST_AGREEMENT"),history:z.literal("APPEND_ONLY_GUEST_AGREEMENT_REQUESTS"),enabled:z.boolean(),
 processing_approval_reference:guestHubFormReferenceSchema.nullable(),wording_approval_reference:guestHubFormReferenceSchema.nullable(),notice:guestHubFormNoticeSchema.nullable(),
 document_type_key:key,template_keys:z.object({en:template,fr:template,ar:template.nullable()}).strict(),arabic_fallback_locale:z.enum(["en","fr"]).nullable(),
 signature_source:z.literal("EXISTING_NATIVE_DOCUMENT_SIGNATURE"),delivery:z.literal("EXISTING_NATIVE_SIGNATURE_EMAIL"),
 submissions:guestHubFormBudgetSchema
}).strict().superRefine((value,context)=>{
 if(value.enabled&&(!value.processing_approval_reference||!value.wording_approval_reference||!value.notice))context.addIssue({code:"custom",path:["wording_approval_reference"],message:"explicit_guest_agreement_wording_and_processing_approval_required"});
 if(value.template_keys.ar!==null&&value.arabic_fallback_locale!==null)context.addIssue({code:"custom",path:["arabic_fallback_locale"],message:"one_explicit_arabic_agreement_language_required"});
});
export type GuestHubAgreementPolicy=z.infer<typeof guestHubAgreementPolicySchema>;
export class GuestHubAgreementAccessError extends Error{constructor(){super("guest_agreement_access_unavailable");}}
export class GuestHubAgreementConflictError extends Error{constructor(){super("guest_agreement_original_changed");}}

export function effectiveGuestHubAgreementPolicy(captured:GuestHubAgreementPolicy,current:GuestHubAgreementPolicy){
 const original=guestHubAgreementPolicySchema.parse(captured),latest=guestHubAgreementPolicySchema.parse(current);
 if(!retainsGuestHubFormPurpose(original,latest)||!original.processing_approval_reference||!original.wording_approval_reference||!latest.notice||original.wording_approval_reference!==latest.wording_approval_reference||original.document_type_key!==latest.document_type_key||JSON.stringify(original.template_keys)!==JSON.stringify(latest.template_keys)||original.arabic_fallback_locale!==latest.arabic_fallback_locale)throw new GuestHubAgreementAccessError();
 return{notice:latest.notice,processingApprovalReference:original.processing_approval_reference,wordingApprovalReference:original.wording_approval_reference,documentTypeKey:latest.document_type_key,templateKeys:latest.template_keys,arabicFallbackLocale:latest.arabic_fallback_locale,limits:[original.submissions,latest.submissions]};
}
/** The original PDF language is chosen once from approved configuration. A later
 * language switch cannot silently replace a prepared or distributed agreement. */
export function guestHubAgreementTemplate(policy:ReturnType<typeof effectiveGuestHubAgreementPolicy>,requestedLocale:AppLocale){
 const locale=requestedLocale==="ar"&&policy.templateKeys.ar===null?policy.arabicFallbackLocale:requestedLocale;if(locale===null)throw new GuestHubAgreementAccessError();const key=policy.templateKeys[locale];if(!key)throw new GuestHubAgreementAccessError();return{requestedLocale,locale,templateKey:key,documentTypeKey:policy.documentTypeKey};
}
