import {afterEach,describe,expect,it,vi} from "vitest";
import {documentEffectiveFromUtc} from "@/modules/documents/domain/document-effective-version";

afterEach(()=>vi.unstubAllEnvs());
describe("explicit UTC document effective timestamps",()=>{
  it("retains the existing blank/archive-time protocol",()=>{expect(documentEffectiveFromUtc("")).toBeNull();});
  it.each(["America/Denver","Africa/Casablanca","Asia/Tokyo"])("retains the entered instant independently of browser or server timezone %s",zone=>{vi.stubEnv("TZ",zone);expect(documentEffectiveFromUtc("2028-02-29T23:45")).toBe("2028-02-29T23:45:00.000Z");});
  it.each(["2026-02-29T12:00","2026-02-30T12:00","2026-04-31T12:00","2026-13-01T12:00","2026-11-06T24:00","2026-11-06T12:60","2026-11-06","2026-11-06T12:00Z","2026-11-06T12:00+01:00","2026-11-06T12:00:01"," "])("rejects an impossible date or ambiguous local/offset field %s",value=>{expect(()=>documentEffectiveFromUtc(value)).toThrow();});
});
