import { describe,expect,it } from "vitest";
import { localClockInstant,localClockLabel,localClockDefault } from "@/platform/time/local-instant";

describe("authoritative financial local clock inputs",()=>{
  it.each([
    ["2026-11-01T08:30:00Z","UTC","2026-11-01T08:30:00","reject"],
    ["2026-11-01T08:30:00Z","America/Los_Angeles","2026-11-01T01:30:00","earlier"],
    ["2026-11-01T09:30:00Z","America/Los_Angeles","2026-11-01T01:30:00","later"],
    ["2026-11-01T08:30:00.123Z","America/Los_Angeles","2026-11-01T01:30:00","earlier"],
    ["2026-10-25T00:30:00Z","Europe/Paris","2026-10-25T02:30:00","earlier"],
    ["2026-10-25T01:30:00Z","Europe/Paris","2026-10-25T02:30:00","later"],
    ["2026-04-04T14:40:00Z","Australia/Lord_Howe","2026-04-05T01:40:00","earlier"],
    ["2026-04-04T15:10:00Z","Australia/Lord_Howe","2026-04-05T01:40:00","later"]
  ] as const)("retains the known instant %s as the default clock in %s",(instant,timezone,local,occurrence)=>{
    const choice=localClockDefault(instant,timezone);expect(choice).toEqual({local,occurrence});
    expect(localClockInstant(choice.local,timezone,choice.occurrence)).toBe(instant.replace(/\.\d{3}Z$/u,"Z"));
  });
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
