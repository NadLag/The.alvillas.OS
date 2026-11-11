import {z} from "zod";
import {inventoryMaximumItems} from "@/platform/config/inventory-policy";
import {serviceCatalogMaximumItems} from "@/platform/config/service-catalog-policy";

export const onboardingPolicyKey="onboarding.wizard";
export const onboardingSteps=["OWNER","PROPERTY","OPERATING_PROFILE","MANAGEMENT_AGREEMENT","TEAM","BOOKING_CHANNELS","INVENTORY","SERVICES","WORKFLOWS","REVIEW","ACTIVATE"] as const;
export const onboardingStepSchema=z.enum(onboardingSteps);
const budget=z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict();
// Protocol batch ceiling; the required business minimum belongs to the approved organization rule.
export const onboardingTeamMaximumAssignments=20;
export const onboardingBookingChannelsMaximum=20;
export const onboardingInventoryPolicySchema=z.object({modes:z.array(z.enum(["TEMPLATE","CUSTOM"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimum_items:z.number().int().min(0).max(inventoryMaximumItems)}).strict();
export const onboardingServicesPolicySchema=z.object({modes:z.array(z.enum(["LINK","TEMPLATE","CUSTOM"])).min(1).max(3).refine(values=>new Set(values).size===values.length),minimum_services:z.number().int().min(0).max(serviceCatalogMaximumItems)}).strict();
export const onboardingBookingChannelsPolicySchema=z.object({modes:z.array(z.enum(["LINK","CONFIGURE"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimum_channels:z.number().int().min(0).max(onboardingBookingChannelsMaximum)}).strict();
export const onboardingTeamPolicySchema=z.object({modes:z.array(z.enum(["LINK","ASSIGN"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimum_assignments:z.number().int().min(0).max(onboardingTeamMaximumAssignments)}).strict();
export const onboardingPolicySchema=z.object({
 source:z.literal("NATIVE_REVIEWED_PROPERTY_ONBOARDING"),
 history:z.literal("APPEND_ONLY_NATIVE_ONBOARDING_STEPS"),
 progress:z.literal("DERIVED_FROM_NATIVE_RECORDS"),
 encryption:z.literal("APP_MANAGED_AUTHENTICATED_ENCRYPTION"),
 release:z.literal("NATIVE_DELIVERY_READINESS"),
 owner_modes:z.array(z.enum(["CREATE","LINK"])).min(1).max(2).refine(values=>new Set(values).size===values.length),
 property_modes:z.array(z.enum(["CREATE","LINK"])).min(1).max(2).refine(values=>new Set(values).size===values.length).optional(),
 property_creation_rule:z.object({key:z.literal("ops.operating_rules"),entry:z.string().trim().min(1).max(120)}).strict().optional(),
 operating_profile_modes:z.array(z.enum(["LINK","UPDATE"])).min(1).max(2).refine(values=>new Set(values).size===values.length).optional(),
 management_agreement_modes:z.array(z.enum(["CREATE","LINK"])).min(1).max(2).refine(values=>new Set(values).size===values.length).optional(),
 team:onboardingTeamPolicySchema.optional(),
 booking_channels:onboardingBookingChannelsPolicySchema.optional(),
 inventory:onboardingInventoryPolicySchema.optional(),
 services:onboardingServicesPolicySchema.optional(),
 admission:budget,reads:budget
}).strict().superRefine((value,context)=>{
 if(value.property_modes?.includes("CREATE")&&!value.property_creation_rule)context.addIssue({code:"custom",message:"native_onboarding_property_creation_rule_required",path:["property_creation_rule"]});
});
export type OnboardingPolicy=z.infer<typeof onboardingPolicySchema>;
