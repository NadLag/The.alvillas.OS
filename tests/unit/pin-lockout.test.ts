import { describe, expect, it } from "vitest";
import { initialPinLockoutPolicy, pinLockoutPolicySchema, pinLockoutState } from "@/modules/identity/domain/pin-lockout";

const now = new Date("2026-10-14T12:00:00Z");
describe("PIN lockout policy", () => {
  it("backs off after the configured failures and caps the delay", () => {
    const policy = { ...initialPinLockoutPolicy, attempts: 3, initialDelaySeconds: 10, maximumDelaySeconds: 40 };
    expect(pinLockoutState({ count: 2, updatedAt: now }, policy, now).locked).toBe(false);
    for (const [count, seconds] of [[3, 10], [4, 20], [5, 40], [1000, 40]]) {
      const state = pinLockoutState({ count, updatedAt: now }, policy, now);
      expect(state.locked).toBe(true);
      expect(state.lockedUntil.getTime() - now.getTime()).toBe(seconds * 1000);
      expect(pinLockoutState({ count, updatedAt: now }, policy, new Date(now.getTime() + seconds * 1000)).locked).toBe(false);
    }
  });
  it("resets after successful verification or the configured quiet period", () => {
    expect(pinLockoutState(null, initialPinLockoutPolicy, now).failures).toBe(0);
    expect(pinLockoutState({ count: 0, updatedAt: now }, initialPinLockoutPolicy, now).locked).toBe(false);
    expect(pinLockoutState({ count: 100, updatedAt: new Date(now.getTime() - initialPinLockoutPolicy.resetAfterSeconds * 1000) }, initialPinLockoutPolicy, now).failures).toBe(0);
  });
  it("rejects policies that disable backoff or reset during a lock", () => {
    expect(pinLockoutPolicySchema.safeParse({ ...initialPinLockoutPolicy, attempts: 0 }).success).toBe(false);
    expect(pinLockoutPolicySchema.safeParse({ ...initialPinLockoutPolicy, maximumDelaySeconds: 1 }).success).toBe(false);
    expect(pinLockoutPolicySchema.safeParse({ ...initialPinLockoutPolicy, resetAfterSeconds: 900 }).success).toBe(false);
  });
});
