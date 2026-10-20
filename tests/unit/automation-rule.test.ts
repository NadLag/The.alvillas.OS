import { describe, it, expect } from "vitest";
import {
  automationRuleSchema,
  boundedJson,
  dueDate,
  evaluate,
  expression,
  field,
  scheduleSlot,
  type AutomationRule,
} from "@/platform/automation/rule";

const ctx = {
  fields: {
    reservation: { nights: 7, check_in: "2027-03-27" },
    amount: "9007199254740992.02",
    flag: false,
  },
  configs: { "ops.mid_stay_threshold": { nights: 4 } },
};
export const rule: AutomationRule = {
  name: { en: "Mid-stay cleaning", fr: "Ménage de mi-séjour" },
  event: "ReservationConfirmed",
  enabled: true,
  conditions: {
    all: [
      {
        path: "reservation.nights",
        op: ">=",
        value: { config: "ops.mid_stay_threshold", path: "nights" },
      },
    ],
  },
  actions: [
    {
      key: "midstay",
      type: "create_task",
      task_type: "CLEANING_MIDSTAY",
      title: { en: "Mid-stay cleaning", fr: "Ménage de mi-séjour" },
      due: { from: "reservation.check_in", offset_days: "floor(nights/2)" },
      priority: "NORMAL",
      checklist_template: "cleaning",
    },
  ],
  retry: { max_attempts: 3, delay_seconds: 5 },
};
describe("versioned automation grammar", () => {
  it("evaluates nested conditions and typed config and field references", () => {
    expect(evaluate(rule.conditions, ctx)).toBe(true);
    expect(
      evaluate(
        {
          all: [
            { any: [{ path: "flag", op: "=", value: false }] },
            { not: { path: "missing", op: "exists" } },
            { path: "reservation.nights", op: "between", value: [3, 8] },
            { path: "reservation.nights", op: "in", value: [4, 7] },
            { path: "reservation.nights", op: "not_in", value: [2] },
          ],
        },
        ctx,
      ),
    ).toBe(true);
    expect(
      evaluate({ path: "amount", op: ">", value: "9007199254740992.01" }, ctx),
    ).toBe(true);
    expect(
      evaluate(
        {
          path: "reservation.nights",
          op: "!=",
          value: { field: "reservation.nights" },
        },
        ctx,
      ),
    ).toBe(false);
    expect(evaluate({ path: "missing", op: "!=", value: 2 }, ctx)).toBe(false);
    expect(() =>
      evaluate({ path: "amount", op: ">", value: { config: "unknown" } }, ctx),
    ).toThrow("automation_config_missing");
  });
  it("rejects executable expressions, prototype traversal, excessive depth and duplicate action keys", () => {
    for (const p of [
      "constructor.name",
      "reservation.__proto__",
      "prototype.x",
    ])
      expect(() => field(ctx.fields, p)).toThrow();
    for (const s of [
      "process.exit()",
      "Function('x')",
      "nights/0",
      "floor(1,2)",
      "nights**2",
      "1;2",
    ])
      expect(() => expression(s, { nights: 7 })).toThrow();
    let nested: unknown = { all: [] };
    for (let i = 0; i < 30; i++) nested = { not: nested };
    expect(boundedJson(nested)).toBe(false);
    expect(
      automationRuleSchema.safeParse({ ...rule, conditions: nested }).success,
    ).toBe(false);
    expect(
      automationRuleSchema.safeParse({
        ...rule,
        actions: [rule.actions[0], rule.actions[0]],
      }).success,
    ).toBe(false);
    expect(
      automationRuleSchema.safeParse({
        ...rule,
        actions: [{ type: "pay_owner", key: "pay" }],
      }).success,
    ).toBe(false);
  });
  it("computes property calendar offsets across timezone transitions without adding UTC hours to instants", () => {
    expect(expression("max(1,min(6,ceil(nights/2)))", { nights: 7 })).toBe(4);
    expect(
      dueDate(
        rule.actions[0] as Extract<
          AutomationRule["actions"][number],
          { type: "create_task" }
        >,
        ctx,
      ),
    ).toBe("2027-03-30");
    expect(expression("-(2+3)*2", {})).toBe(-10);
  });
  it("uses local dates to recover missed polls and deduplicate the repeated DST hour", () => {
    const scheduled = {
      ...rule,
      schedule: { hour: 1, minute: 30, weekdays: [0] },
    };
    expect(
      scheduleSlot(
        scheduled,
        "America/New_York",
        new Date("2026-11-01T05:45Z"),
      ),
    ).toBe("2026-11-01");
    expect(
      scheduleSlot(
        scheduled,
        "America/New_York",
        new Date("2026-11-01T06:45Z"),
      ),
    ).toBe("2026-11-01");
    expect(
      scheduleSlot(
        scheduled,
        "America/New_York",
        new Date("2026-11-01T04:45Z"),
      ),
    ).toBeNull();
    expect(
      scheduleSlot(
        { ...rule, schedule: { hour: 2, minute: 30, weekdays: [0] } },
        "America/New_York",
        new Date("2027-03-14T07:05Z"),
      ),
    ).toBe("2027-03-14");
    expect(
      automationRuleSchema.safeParse({
        ...scheduled,
        schedule: { ...scheduled.schedule, timezone: "Invalid/Place" },
      }).success,
    ).toBe(false);
  });
});
