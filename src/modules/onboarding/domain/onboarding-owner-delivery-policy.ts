import {z} from "zod";

export const onboardingOwnerDeliveryPolicyKey="onboarding.owner_delivery";
export const onboardingOwnerDeliveryPolicySchema=z.object({
 source:z.literal("NATIVE_COMPLETED_OWNER_PACKAGE"),channel:z.literal("EMAIL"),template:z.literal("NATIVE_OWNER_PACKAGE_EMAIL_V1"),
 locales:z.array(z.enum(["en","fr","ar"])).min(2).max(3)
}).strict().refine(value=>new Set(value.locales).size===value.locales.length&&value.locales.includes("en")&&value.locales.includes("fr"),"approved_english_and_french_email_variants_required");
export type OnboardingOwnerDeliveryPolicy=z.infer<typeof onboardingOwnerDeliveryPolicySchema>;
