import { describe,expect,it } from "vitest";
import { Money } from "@/platform/money/money";
import { employeeHourlyEarnedAmount,type EmployeeHourlyInterval } from "@/modules/finance/domain/employee-hourly-earnings";
const policy={evidence:"VALIDATED_COMPLETED_WORK_INTERVALS",rate_selection:"ACTUAL_EFFECTIVE_INSTANTS",rounding:"HALF_UP_AT_EARNING_TOTAL",max_interval_seconds:"100000000000",max_total_seconds:"100000000000",require_distinct_validator:true};
const at=(value:string)=>new Date(value),rate=(amount:string,currency="MAD")=>Money.of(amount,currency);
function interval(start="2026-01-15T10:00:00Z",end="2026-01-15T11:00:00Z",amount="500.25",id="actual-interval"):EmployeeHourlyInterval{return{id,startsAt:at(start),endsAt:at(end),performedByPersonId:"actual-performer",validatedByPersonId:"actual-validator",slices:[{startsAt:at(start),endsAt:at(end),rate:rate(amount)}]};}
const calculate=(intervals:EmployeeHourlyInterval[],rules:unknown=policy)=>employeeHourlyEarnedAmount(rules,"MAD",at("2027-01-01T00:00:00Z"),intervals);
describe("actual hourly interval calculation",()=>{
  it("uses actual elapsed seconds and the original hourly contract",()=>{const result=calculate([interval()]);expect(result.seconds).toBe("3600");expect(result.amount.toJSON()).toEqual({amount:"500.25",currency:"MAD"});});
  it("retains both effective rates across a rate change and rounds once",()=>{const row=interval("2026-01-15T10:00:00Z","2026-01-15T12:00:00Z");row.slices=[{startsAt:row.startsAt,endsAt:at("2026-01-15T11:00:00Z"),rate:rate("600.00")},{startsAt:at("2026-01-15T11:00:00Z"),endsAt:row.endsAt,rate:rate("900.00")}];expect(calculate([row]).amount.toJSON().amount).toBe("1500.00");});
  it("rounds two half-cent intervals only after the complete earning total",()=>{const rows=[interval("2026-01-15T10:00:00Z","2026-01-15T10:00:01Z","18.00","first"),interval("2026-01-15T11:00:00Z","2026-01-15T11:00:01Z","18.00","second")];expect(calculate(rows).amount.toJSON().amount).toBe("0.01");expect(calculate(rows).seconds).toBe("2");});
  it("uses elapsed instants through a daylight-saving overlap",()=>{expect(calculate([interval("2026-11-01T01:30:00-04:00","2026-11-01T01:30:00-05:00")]).seconds).toBe("3600");});
  it("excludes breaks between actual intervals and accepts adjacent intervals in any input order",()=>{const first=interval("2026-01-15T10:00:00Z","2026-01-15T10:30:00Z","100.00","first"),last=interval("2026-01-15T11:00:00Z","2026-01-15T11:30:00Z","100.00","last");expect(calculate([last,first]).amount.toJSON().amount).toBe("100.00");});
  it("keeps a large exact rate and one final half-up rounding",()=>{expect(calculate([interval("2026-01-15T10:00:00Z","2026-01-15T10:00:01Z","9999999999999999.99")]).amount.toJSON().amount).toBe("2777777777777.78");});
  it.each([
    ["overlap",()=>[interval(),interval("2026-01-15T10:30:00Z","2026-01-15T11:30:00Z","500.25","other")]],
    ["duplicate source",()=>[interval(),interval()]],
    ["missing intervals",()=>[]],
    ["missing effective slices",()=>[{...interval(),slices:[]}]],
    ["self validation",()=>[{...interval(),validatedByPersonId:"actual-performer"}]],
    ["missing validator",()=>[{...interval(),validatedByPersonId:""}]],
    ["mixed performers",()=>[interval(),{...interval("2026-01-15T12:00:00Z","2026-01-15T13:00:00Z","500.25","other"),performedByPersonId:"other-person"}]],
    ["negative elapsed time",()=>[interval("2026-01-15T11:00:00Z","2026-01-15T10:00:00Z")]],
    ["non-finite end",()=>[interval("2026-01-15T10:00:00Z","invalid")]],
    ["after completion",()=>[interval("2027-01-02T10:00:00Z","2027-01-02T11:00:00Z")]],
    ["invalid instant",()=>[interval("invalid","2026-01-15T11:00:00Z")]],
    ["rate gap",()=>[{...interval(),slices:[{startsAt:at("2026-01-15T10:00:01Z"),endsAt:at("2026-01-15T11:00:00Z"),rate:rate("10.00")}]}]],
    ["foreign currency",()=>[{...interval(),slices:[{...interval().slices[0],rate:rate("10.00","EUR")}]}]],
    ["negative contract",()=>[{...interval(),slices:[{...interval().slices[0],rate:rate("-1.00")}]}]]
  ] as const)("rejects %s before returning an earning",(_name,build)=>{expect(()=>calculate(build())).toThrow();});
  it("enforces configured interval and aggregate limits independently",()=>{expect(()=>calculate([interval()],{...policy,max_interval_seconds:"3599"})).toThrow();expect(()=>calculate([interval()],{...policy,max_total_seconds:"3599"})).toThrow();expect(calculate([interval()],{...policy,max_interval_seconds:"3600",max_total_seconds:"3600"}).seconds).toBe("3600");});
  it("honors an explicit configured self-validation choice",()=>{expect(calculate([{...interval(),validatedByPersonId:"actual-performer"}],{...policy,require_distinct_validator:false}).seconds).toBe("3600");});
  it("retains millisecond work, completion and effective-rate boundaries without early rounding",()=>{
    const row=interval("2026-01-15T10:00:00.000Z","2026-01-15T10:00:00.002Z","18000.00");row.slices=[{startsAt:row.startsAt,endsAt:at("2026-01-15T10:00:00.001Z"),rate:rate("18000.00")},{startsAt:at("2026-01-15T10:00:00.001Z"),endsAt:row.endsAt,rate:rate("18000.00")}];
    const result=employeeHourlyEarnedAmount(policy,"MAD",at("2026-01-15T10:00:00.003Z"),[row]);expect(result.seconds).toBe("0.002");expect(result.milliseconds).toBe("2");expect(result.amount.toJSON().amount).toBe("0.01");
  });
});
