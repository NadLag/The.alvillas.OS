import {z} from "zod";
import {guestHubFormBudgetSchema,guestHubFormNoticeSchema,guestHubFormReferenceSchema,retainsGuestHubFormPurpose} from "./guest-hub-form-policy";

export const guestHubServiceOrderPolicyKey="guest_hub.service_orders";
const lifetime=z.number().int().positive().max(2147483647);
export const guestHubServiceOrderPolicySchema=z.object({
 source:z.literal("NATIVE_CANONICAL_SERVICE_ORDERS"),history:z.literal("APPEND_ONLY_GUEST_NATIVE_ORDER_RECEIPTS"),enabled:z.boolean(),
 processing_approval_reference:guestHubFormReferenceSchema.nullable(),wording_approval_reference:guestHubFormReferenceSchema.nullable(),notice:guestHubFormNoticeSchema.nullable(),
 public_offers:z.literal("EXPLICITLY_RELEASED_CANONICAL_CATALOG"),request_authority:z.literal("HELD_AND_CURRENT_RELEASE_ACTOR"),
 review_lifetime_seconds:lifetime,release_lifetime_seconds:lifetime,submissions:guestHubFormBudgetSchema
}).strict().superRefine((value,context)=>{if(value.enabled&&(!value.processing_approval_reference||!value.wording_approval_reference||!value.notice))context.addIssue({code:"custom",path:["processing_approval_reference"],message:"explicit_guest_service_order_processing_and_wording_approval_required"});});
export type GuestHubServiceOrderPolicy=z.infer<typeof guestHubServiceOrderPolicySchema>;
export class GuestHubServiceOrderAccessError extends Error{constructor(){super("guest_service_order_access_unavailable");}}
export class GuestHubServiceOrderConflictError extends Error{constructor(){super("guest_service_order_original_changed");}}
export class GuestHubServiceOrderConfigurationError extends Error{constructor(){super("guest_service_order_configuration_required");}}
export function effectiveGuestHubServiceOrderPolicy(captured:GuestHubServiceOrderPolicy,current:GuestHubServiceOrderPolicy){
 const original=guestHubServiceOrderPolicySchema.parse(captured),latest=guestHubServiceOrderPolicySchema.parse(current);if(!retainsGuestHubFormPurpose(original,latest)||!original.processing_approval_reference||!original.wording_approval_reference||original.wording_approval_reference!==latest.wording_approval_reference||!latest.notice)throw new GuestHubServiceOrderAccessError();return{notice:latest.notice,processingApprovalReference:original.processing_approval_reference,wordingApprovalReference:original.wording_approval_reference,reviewLifetimeSeconds:Math.min(original.review_lifetime_seconds,latest.review_lifetime_seconds),releaseLifetimeSeconds:Math.min(original.release_lifetime_seconds,latest.release_lifetime_seconds),limits:[original.submissions,latest.submissions]};
}
