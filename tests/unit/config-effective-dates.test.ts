import { describe, expect, it } from "vitest";
import { configRuleInputSchema, configRuleLifecycleActionSchema } from "@/modules/config/application/config-service";

describe("configuration effective instants", () => {
  for (const instant of ["2026-03-08T02:30", "2026-11-01T01:30"]) it(`keeps the declared UTC form time ${instant} across host DST rules`, () => {
    const rule = configRuleInputSchema.parse({ key: "feature_flag.timezone", scopeType: "organization", lifecycle: "DRAFT",
      valueJson: '{"enabled":true}', effectiveFrom: instant, effectiveTo: "2027-01-01T00:00", reason: "Explicit UTC rule interval" });
    expect(rule.effectiveFrom.toISOString()).toBe(`${instant}:00.000Z`);
    expect(rule.effectiveTo?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const action = configRuleLifecycleActionSchema.parse({ ruleId: "8cd060bd-c748-47d9-ae35-4b99f5cfc0d0", effectiveFrom: instant, reason: "Explicit UTC activation" });
    expect(action.effectiveFrom).toEqual(rule.effectiveFrom);
  });
  it("preserves explicitly offset and Date-valued service instants", () => {
    const input = { ruleId: "8cd060bd-c748-47d9-ae35-4b99f5cfc0d0", reason: "Existing explicit service instant" };
    const expected = new Date("2026-11-01T07:30:00Z");
    expect(configRuleLifecycleActionSchema.parse({ ...input, effectiveFrom: "2026-11-01T01:30:00-06:00" }).effectiveFrom).toEqual(expected);
    expect(configRuleLifecycleActionSchema.parse({ ...input, effectiveFrom: expected }).effectiveFrom).toEqual(expected);
  });
});
