import {z} from "zod";
export const onboardingOwnerSchema=z.object({displayName:z.string(),email:z.string().nullable(),phone:z.string().nullable(),preferredLocale:z.enum(["en","fr","ar"])}).strict();

export const onboardingIdSchema=z.uuid().transform(value=>value.toLowerCase());
export const onboardingFingerprintSchema=z.string().regex(/^[a-f0-9]{64}$/u);
export const onboardingCommandFields={idempotencyKey:onboardingIdSchema,reviewFingerprint:onboardingFingerprintSchema,reason:z.string().trim().min(1).max(1000)};
