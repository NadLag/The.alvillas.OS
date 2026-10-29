import { describe,expect,it } from "vitest";
import { localClockInstant,localClockLabel } from "@/platform/time/local-instant";

describe("authoritative financial local clock inputs",()=>{
  it("requires an explicit occurrence for a repeated clock and preserves both distinct instants",()=>{
    expect(()=>localClockInstant("2026-11-01T01:30","America/Denver")).toThrow(RangeError);
    expect(localClockInstant("2026-11-01T01:30","America/Denver","earlier")).toBe("2026-11-01T07:30:00Z");
    expect(localClockInstant("2026-11-01T01:30","America/Denver","later")).toBe("2026-11-01T08:30:00Z");
  });
  it("refuses nonexistent local times instead of silently moving an administrator's financial instruction",()=>{
    for(const occurrence of ["reject","earlier","later"] as const)expect(()=>localClockInstant("2026-03-08T02:30","America/Denver",occurrence)).toThrow(RangeError);
  });
  it("uses current Casablanca data for round trips without relying on the browser or PostgreSQL zone tables",()=>{
    expect(localClockInstant("2026-11-02T09:00","Africa/Casablanca")).toBe("2026-11-02T09:00:00Z");
    expect(localClockLabel("2026-11-02T09:00:00Z","Africa/Casablanca")).toBe("2026-11-02T09:00:00");
  });
});
