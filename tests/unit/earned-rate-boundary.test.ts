import {describe,expect,it} from "vitest";
import {completedRateBoundary} from "../integration/support/earned-rate-boundary";
describe("completed actual rate-change fixture boundaries",()=>{
 it.each([
  ["2026-11-01T00:00:00.000Z","2026-10-31T00:00:00.000Z"],
  ["2026-11-01T00:29:59.999Z","2026-10-31T00:00:00.000Z"],
  ["2026-11-01T00:30:00.000Z","2026-11-01T00:00:00.000Z"],
  ["2026-11-01T12:34:56.123Z","2026-11-01T00:00:00.000Z"],
  ["2027-01-01T00:10:00.000Z","2026-12-31T00:00:00.000Z"],
  ["2024-03-01T00:01:00.000Z","2024-02-29T00:00:00.000Z"],
  ["2025-03-01T00:01:00.000Z","2025-02-28T00:00:00.000Z"]
 ])("keeps both original rate segments before completion %s",(completed,expected)=>{const boundary=completedRateBoundary(new Date(completed),1800000);expect(boundary.toISOString()).toBe(expected);expect(boundary.getTime()+1800000).toBeLessThanOrEqual(new Date(completed).getTime());expect(boundary.getUTCHours()).toBe(0);});
 it("rejects invalid margins",()=>{for(const margin of[-1,0.5,Infinity])expect(()=>completedRateBoundary(new Date("2026-11-01T00:10:00Z"),margin)).toThrow(RangeError);});
 it("rejects an invalid completion instant",()=>{expect(()=>completedRateBoundary(new Date("invalid"),1800000)).toThrow(RangeError);});
});
