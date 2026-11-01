import {describe,expect,it} from "vitest";
import {utcDateTimeLocalValue} from "../e2e/support/date-time-local";
export const dateTimeLocalCases=[
 ["2026-10-31T12:34:00.000Z","2026-10-31T12:34"],
 ["2026-10-31T12:00:00.000Z","2026-10-31T12:00"],
 ["2026-11-01T00:00:00.000Z","2026-11-01T00:00"],
 ["2026-10-31T12:34:09.000Z","2026-10-31T12:34:09"],
 ["2026-10-31T12:34:00.001Z","2026-10-31T12:34:00.001"],
 ["2026-10-31T12:34:09.010Z","2026-10-31T12:34:09.01"],
 ["2026-10-31T12:34:00.100Z","2026-10-31T12:34:00.1"],
 ["2026-10-31T12:34:09.120Z","2026-10-31T12:34:09.12"],
 ["2026-10-31T12:34:09.999Z","2026-10-31T12:34:09.999"]
] as const;
describe("canonical UTC values for native datetime controls",()=>{
 it.each(dateTimeLocalCases)("retains the complete exact instant %s as %s",(iso,expected)=>{const actual=utcDateTimeLocalValue(new Date(iso));expect(actual).toBe(expected);expect(new Date(actual+"Z").toISOString()).toBe(iso);});
 it("rejects an invalid instant",()=>{expect(()=>utcDateTimeLocalValue(new Date("invalid"))).toThrow(RangeError);});
});
