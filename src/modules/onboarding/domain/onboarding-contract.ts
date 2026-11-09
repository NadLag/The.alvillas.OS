import {z} from "zod";

export const onboardingIdSchema=z.uuid().transform(value=>value.toLowerCase());
export const onboardingFingerprintSchema=z.string().regex(/^[a-f0-9]{64}$/u);
export const onboardingCommandFields={idempotencyKey:onboardingIdSchema,reviewFingerprint:onboardingFingerprintSchema,reason:z.string().trim().min(1).max(1000)};
