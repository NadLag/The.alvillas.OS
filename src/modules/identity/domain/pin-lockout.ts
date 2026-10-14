import { z } from "zod";

export const pinLockoutConfigKey = "identity.pin_lockout";
export const pinLockoutPolicySchema = z.object({
  attempts: z.number().int().min(1).max(10),
  initialDelaySeconds: z.number().int().min(1).max(3600),
  maximumDelaySeconds: z.number().int().min(1).max(86400),
  resetAfterSeconds: z.number().int().min(1).max(604800)
}).refine((value) => value.maximumDelaySeconds >= value.initialDelaySeconds &&
  value.resetAfterSeconds > value.maximumDelaySeconds);

// Persisted as the first config_rule version; administrators can version the policy.
export const initialPinLockoutPolicy = {
  attempts: 5, initialDelaySeconds: 60, maximumDelaySeconds: 900, resetAfterSeconds: 86400
};
export type PinLockoutPolicy = z.infer<typeof pinLockoutPolicySchema>;
export type PinFailureState = { count: number; updatedAt: Date };

export function pinLockoutState(state: PinFailureState | null, policy: PinLockoutPolicy, now: Date) {
  const failures = !state || now.getTime() - state.updatedAt.getTime() >= policy.resetAfterSeconds * 1000
    ? 0 : state.count;
  const seconds = failures < policy.attempts ? 0 : Math.min(
    policy.maximumDelaySeconds,
    policy.initialDelaySeconds * 2 ** Math.min(failures - policy.attempts, 30)
  );
  const lockedUntil = new Date((state?.updatedAt.getTime() ?? now.getTime()) + seconds * 1000);
  return { failures, locked: seconds > 0 && lockedUntil.getTime() > now.getTime(), lockedUntil };
}
