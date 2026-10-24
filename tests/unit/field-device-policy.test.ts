import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldDevicePolicyKey, fieldDevicePolicySchema, fieldDevicePolicySnapshot } from "@/platform/config/field-device-policy";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";

describe("configured field device hygiene", () => {
  it("requires an explicit duration or disabled value without supplying a business default", () => {
    for (const queueWarningAfterMinutes of [null, 0, 1, 731]) {
      const policy = { queueWarningAfterMinutes };
      expect(parseConfigRuleValue(fieldDevicePolicyKey, policy)).toEqual(policy);
    }
    expect(fieldDevicePolicySchema.safeParse({}).success).toBe(false);
    expect(fieldDevicePolicySnapshot(null)).toBeNull();
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "60"])("rejects unsafe or ambiguous durations: %s", queueWarningAfterMinutes => {
    expect(fieldDevicePolicySchema.safeParse({ queueWarningAfterMinutes }).success).toBe(false);
  });
  it("publishes only the validated operational value and immutable configuration identity", () => {
    const id = randomUUID(), policy = { queueWarningAfterMinutes: 73 };
    expect(fieldDevicePolicySnapshot({ id, key: fieldDevicePolicyKey, version: 4, parsedValue: policy })).toEqual({ ...policy, configRuleId: id, configVersion: 4 });
    expect(fieldDevicePolicySnapshot({ id, key: fieldDevicePolicyKey, version: 5, parsedValue: { queueWarningAfterMinutes: null } })).toEqual({ queueWarningAfterMinutes: null, configRuleId: id, configVersion: 5 });
    expect(() => fieldDevicePolicySnapshot({ id, key: "finance.commission", version: 4, parsedValue: policy })).toThrow("Unexpected field device policy key");
    expect(fieldDevicePolicySchema.safeParse({ ...policy, amount: "100.00" }).success).toBe(false);
    expect(() => fieldDevicePolicySnapshot({ id, key: fieldDevicePolicyKey, version: 0, parsedValue: policy })).toThrow();
  });
});
