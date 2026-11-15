import {z} from "zod";
import {propertyHouseRulesSchema} from "@/platform/config/property-house-rules";
import {guestHubFormBudgetSchema,guestHubFormNoticeSchema,guestHubFormReferenceSchema,retainsGuestHubFormPurpose} from "./guest-hub-form-policy";
import {guestHubHouseRulesContentSchema} from "./guest-hub-house-rules-content";

export const guestHubHouseRulesPolicyKey="guest_hub.house_rules";
const canonicalSourceRules=z.array(z.string()).refine(raw=>{
 const parsed=propertyHouseRulesSchema.safeParse(raw);
 return parsed.success&&parsed.data.length>0&&JSON.stringify(parsed.data)===JSON.stringify(raw);
});
export const guestHubHouseRulesApprovedContentSchema=guestHubHouseRulesContentSchema.extend({source_rules:canonicalSourceRules}).strict().superRefine((value,context)=>{
 if(value.source_rules.length!==value.rules.length)context.addIssue({code:"custom",path:["rules"],message:"every_canonical_house_rule_requires_approved_wording"});
});
export const guestHubHouseRulesPolicySchema=z.object({
 source:z.literal("NATIVE_PROPERTY_HOUSE_RULES_ACCEPTANCE"),history:z.literal("APPEND_ONLY_RESERVATION_HOUSE_RULES_ACCEPTANCE"),enabled:z.boolean(),
 processing_approval_reference:guestHubFormReferenceSchema.nullable(),wording_approval_reference:guestHubFormReferenceSchema.nullable(),
 notice:guestHubFormNoticeSchema.nullable(),approved_content:guestHubHouseRulesApprovedContentSchema.nullable(),
 require_acknowledgement:z.literal(true),submissions:guestHubFormBudgetSchema
}).strict().superRefine((value,context)=>{
 if(value.enabled&&(!value.processing_approval_reference||!value.wording_approval_reference||!value.notice||!value.approved_content))context.addIssue({code:"custom",path:["approved_content"],message:"explicit_house_rules_source_wording_and_processing_approval_required"});
});
export type GuestHubHouseRulesPolicy=z.infer<typeof guestHubHouseRulesPolicySchema>;
export class GuestHubHouseRulesAccessError extends Error{constructor(){super("guest_house_rules_access_unavailable");}}
export class GuestHubHouseRulesConflictError extends Error{constructor(){super("guest_house_rules_review_changed");}}
export class GuestHubHouseRulesConfigurationError extends Error{constructor(){super("guest_house_rules_configuration_unavailable");}}

export function effectiveGuestHubHouseRulesPolicy(captured:GuestHubHouseRulesPolicy,current:GuestHubHouseRulesPolicy){
 const original=guestHubHouseRulesPolicySchema.parse(captured),latest=guestHubHouseRulesPolicySchema.parse(current);
 if(!retainsGuestHubFormPurpose(original,latest)||!latest.notice||!original.processing_approval_reference||!original.wording_approval_reference||original.wording_approval_reference!==latest.wording_approval_reference||!original.approved_content||!latest.approved_content||JSON.stringify(original.approved_content)!==JSON.stringify(latest.approved_content))throw new GuestHubHouseRulesAccessError();
 const content=latest.approved_content,approvedContent=guestHubHouseRulesContentSchema.parse({title:content.title,rules:content.rules,acceptanceStatement:content.acceptanceStatement});
 return{notice:latest.notice,approvedSourceRules:content.source_rules,approvedContent,processingApprovalReference:original.processing_approval_reference,wordingApprovalReference:original.wording_approval_reference,requireAcknowledgement:true as const,limits:[original.submissions,latest.submissions]};
}
