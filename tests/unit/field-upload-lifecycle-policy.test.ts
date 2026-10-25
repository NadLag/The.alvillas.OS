import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fieldUploadLifecycleKey, fieldUploadLifecycleSchema, fieldUploadLifecycleSnapshot } from "@/platform/config/field-upload-lifecycle-policy";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";

describe("configured inactive upload policy", () => {
  it("retains unconfigured uploads and requires an explicit idle duration or disabled value", () => {
    expect(fieldUploadLifecycleSnapshot(null)).toBeNull(); expect(fieldUploadLifecycleSchema.safeParse({}).success).toBe(false);
    for (const openUploadIdleAfterMinutes of [null, 0, 1, 732]) expect(parseConfigRuleValue(fieldUploadLifecycleKey, { openUploadIdleAfterMinutes })).toEqual({ openUploadIdleAfterMinutes });
  });
  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER, "60"])("rejects unsafe or ambiguous inactivity: %s", openUploadIdleAfterMinutes => {
    expect(fieldUploadLifecycleSchema.safeParse({ openUploadIdleAfterMinutes }).success).toBe(false);
  });
  it("binds expiry to an immutable rule identity and version without accepting another policy key", () => {
    const id = randomUUID(), value = { openUploadIdleAfterMinutes: 73 };
    expect(fieldUploadLifecycleSnapshot({ id, key: fieldUploadLifecycleKey, version: 2, parsedValue: value })).toEqual({ ...value, configRuleId: id, configVersion: 2 });
    expect(() => fieldUploadLifecycleSnapshot({ id, key: "finance.commission", version: 2, parsedValue: value })).toThrow("Unexpected field upload lifecycle policy key");
    expect(fieldUploadLifecycleSchema.safeParse({ ...value, amount: "100.00" }).success).toBe(false);
  });
});
