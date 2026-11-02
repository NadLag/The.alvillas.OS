import {describe,expect,it} from "vitest";
import {nextRecurringExpenseDate,recurringExpenseDue,recurringExpensePolicySchema,recurringExpenseScheduleSchema,type RecurringExpenseSchedule} from "@/modules/finance/domain/recurring-expense";

const schedule:RecurringExpenseSchedule={id:"f8ac1a89-4bbb-44ac-b7f2-a49807c98671",start_on:"2026-01-01",end_on:null,run_at:"09:00",cadence:{kind:"DAY",every:1},draft:{propertyId:"efcd519f-c777-4fd3-8dab-de7f9beea33d",fundingAccountId:"f8ac1a89-4bbb-44ac-b7f2-a49807c98671",amount:"0.07",currency:"MAD",category:"maintenance",purpose:"Configured recurring property expense"}};
describe("configured recurring expense civil occurrences",()=>{
 it.each([
  [{kind:"DAY",every:3},null,"2026-01-01"],
  [{kind:"DAY",every:3},"2026-01-01","2026-01-04"],
  [{kind:"DAY",every:3},"2026-01-05","2026-01-07"],
  [{kind:"WEEK",every:2,weekdays:[1,5]},null,"2026-01-02"],
  [{kind:"WEEK",every:2,weekdays:[1,5]},"2026-01-02","2026-01-12"],
  [{kind:"WEEK",every:2,weekdays:[1,5]},"2026-01-12","2026-01-16"],
  [{kind:"MONTH",every:1,day:31,missing_day:"SKIP"},"2026-01-31","2026-03-31"],
  [{kind:"MONTH",every:1,day:31,missing_day:"LAST_DAY"},"2026-01-31","2026-02-28"],
  [{kind:"MONTH",every:3,day:15,missing_day:"SKIP"},"2026-01-15","2026-04-15"],
  [{kind:"MONTH",every:12,day:31,missing_day:"SKIP"},"2026-01-31","2027-01-31"]
 ]as const)("keeps its configured anchor for %o after %s",(cadence,after,expected)=>{
  expect(nextRecurringExpenseDate({...schedule,cadence:{...cadence,...("weekdays"in cadence?{weekdays:[...cadence.weekdays]}:{})}as RecurringExpenseSchedule["cadence"]},after)).toBe(expected);
 });
 it("handles Gregorian leap days without a guessed financial day",()=>{const item={...schedule,start_on:"2024-02-01",cadence:{kind:"MONTH"as const,every:12,day:29,missing_day:"SKIP"as const}};expect(nextRecurringExpenseDate(item,"2024-02-29")).toBe("2028-02-29");});
 it("does not generate an impossible explicit annual date",()=>expect(nextRecurringExpenseDate({...schedule,start_on:"2026-02-01",cadence:{kind:"MONTH",every:12,day:31,missing_day:"SKIP"}},null)).toBeNull());
 it("honors the inclusive end date and never repeats a completed occurrence",()=>{expect(nextRecurringExpenseDate({...schedule,end_on:"2026-01-02"},"2026-01-01")).toBe("2026-01-02");expect(nextRecurringExpenseDate({...schedule,end_on:"2026-01-02"},"2026-01-02")).toBeNull();});
 it("catches up a missed civil date independently of today's send time",()=>expect(recurringExpenseDue("2026-01-01",schedule,new Date("2026-01-02T01:00:00Z"),"UTC")).toBe(true));
 it("uses the actual property civil clock",()=>{expect(recurringExpenseDue("2026-01-02",schedule,new Date("2026-01-02T08:59:00Z"),"UTC")).toBe(false);expect(recurringExpenseDue("2026-01-02",schedule,new Date("2026-01-02T09:00:00Z"),"UTC")).toBe(true);expect(recurringExpenseDue("2026-01-03",schedule,new Date("2026-01-02T23:00:00Z"),"UTC")).toBe(false);});
 it("retains one stable civil date through both DST occurrences",()=>{for(const at of["2026-11-01T05:30:00Z","2026-11-01T06:30:00Z"])expect(recurringExpenseDue("2026-11-01",{...schedule,run_at:"01:30"},new Date(at),"America/New_York")).toBe(true);});
 it("requires explicit business values and rejects duplicate identities and automatic payment",()=>{const policy={source:"PROPERTY_EXPENSE_DRAFT",principal:"CURRENT_CONFIGURATION_AUTHOR",batch_size:50,expenses:[schedule]};expect(recurringExpensePolicySchema.parse(policy).expenses[0].draft.amount).toBe("0.07");for(const invalid of[{...policy,batch_size:undefined},{...policy,expenses:[schedule,schedule]},{...policy,auto_pay:true},{...policy,principal:"SYSTEM"}])expect(recurringExpensePolicySchema.safeParse(invalid).success).toBe(false);});
 it("normalizes accepted UUID casing before durable identity and tenant source comparisons",()=>{const uppercase={...schedule,id:schedule.id.toUpperCase(),draft:{...schedule.draft,propertyId:schedule.draft.propertyId.toUpperCase(),fundingAccountId:schedule.draft.fundingAccountId.toUpperCase()}};expect(recurringExpenseScheduleSchema.parse(uppercase)).toEqual(schedule);expect(recurringExpenseScheduleSchema.parse(schedule)).toEqual(schedule);expect(recurringExpensePolicySchema.safeParse({source:"PROPERTY_EXPENSE_DRAFT",principal:"CURRENT_CONFIGURATION_AUTHOR",batch_size:25,expenses:[schedule,uppercase]}).success).toBe(false);});
 it("rejects reversed ranges, duplicate weekdays, zero cadence, guessed month-end and money floats",()=>{for(const invalid of[{...schedule,end_on:"2025-12-31"},{...schedule,cadence:{kind:"WEEK",every:1,weekdays:[1,1]}},{...schedule,cadence:{kind:"DAY",every:0}},{...schedule,cadence:{kind:"MONTH",every:1,day:31}},{...schedule,draft:{...schedule.draft,amount:0.07}},{...schedule,draft:{...schedule.draft,emergency:true}}])expect(recurringExpenseScheduleSchema.safeParse(invalid).success).toBe(false);});
});
