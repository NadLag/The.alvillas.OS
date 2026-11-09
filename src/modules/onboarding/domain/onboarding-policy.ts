import {z} from "zod";

export const onboardingPolicyKey="onboarding.wizard";
export const onboardingSteps=["OWNER","PROPERTY","OPERATING_PROFILE","MANAGEMENT_AGREEMENT","TEAM","BOOKING_CHANNELS","INVENTORY","SERVICES","WORKFLOWS","REVIEW","ACTIVATE"] as const;
export const onboardingStepSchema=z.enum(onboardingSteps);
const budget=z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict();
export const onboardingPolicySchema=z.object({
 source:z.literal("NATIVE_REVIEWED_PROPERTY_ONBOARDING"),
 history:z.literal("APPEND_ONLY_NATIVE_ONBOARDING_STEPS"),
 progress:z.literal("DERIVED_FROM_NATIVE_RECORDS"),
 encryption:z.literal("APP_MANAGED_AUTHENTICATED_ENCRYPTION"),
 release:z.literal("NATIVE_DELIVERY_READINESS"),
 owner_modes:z.array(z.enum(["CREATE","LINK"])).min(1).max(2).refine(values=>new Set(values).size===values.length),
 admission:budget,reads:budget
}).strict();
export type OnboardingPolicy=z.infer<typeof onboardingPolicySchema>;
