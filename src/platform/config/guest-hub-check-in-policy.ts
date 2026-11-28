import { z } from "zod";

export const guestHubCheckInPolicyKey = "guest_hub.check_in";

export const guestHubCheckInRequirementSchema = z.enum([
  "PROFILE", "ARRIVAL_DETAILS", "DEPARTURE_DETAILS", "HOUSE_RULES", "IDENTITY_DOCUMENTS", "SIGNED_AGREEMENT"
]);
export type GuestHubCheckInRequirement = z.infer<typeof guestHubCheckInRequirementSchema>;

export const guestHubCheckInPolicySchema = z.object({
  source: z.literal("NATIVE_GUEST_FORM_EVIDENCE"),
  enabled: z.boolean(),
  required_forms: z.array(guestHubCheckInRequirementSchema).max(guestHubCheckInRequirementSchema.options.length)
    .refine(forms => new Set(forms).size === forms.length, "guest_check_in_requires_distinct_forms")
}).strict().refine(policy => !policy.enabled || policy.required_forms.length > 0, {
  path: ["required_forms"], message: "enabled_guest_check_in_requires_explicit_forms"
});

export const guestHubCheckInReadinessSchema = z.object({
  ready: z.boolean(),
  requirements: z.array(z.object({ form: guestHubCheckInRequirementSchema, complete: z.boolean() }).strict())
}).strict();
export type GuestHubCheckInReadiness = z.infer<typeof guestHubCheckInReadinessSchema>;
