import { describe, expect, it } from "vitest";
import { calendarDateStart } from "@/platform/time/calendar";
import { calendarDateAt } from "@/i18n/format";

describe("financial occurrence dates use the property's calendar", () => {
  for (const [day, timezone] of [["2026-03-08","America/New_York"],["2026-10-25","Europe/Paris"],
    ["2026-02-15","Africa/Casablanca"],["2026-10-26","Asia/Kathmandu"],["2026-10-26","Pacific/Kiritimati"]])
    it(`finds the first instant of ${day} in ${timezone}`, () => {
      const instant = calendarDateStart(day, timezone);
      expect(calendarDateAt(instant, timezone)).toBe(day); expect(calendarDateAt(new Date(instant.getTime()-1), timezone) < day).toBe(true);
    });
  it("rejects a skipped date instead of applying the next date's financial rules", () => {
    expect(() => calendarDateStart("2011-12-30","Pacific/Apia")).toThrow("does not exist");
  });
});
