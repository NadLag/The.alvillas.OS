import { z } from "zod";
import { Money } from "@/platform/money/money";
import { calendarDateStart } from "@/platform/time/calendar";
import { accountingPeriodPolicySchema } from "./accounting-period";
import { EmployeeCompensationBasisError } from "./employee-compensation";

export const employeeMonthlyEarningsPolicyKey="staff.compensation_monthly_earnings";
/** Contractual choices are explicit configuration; no statutory payroll or proration default is inferred. */
export const employeeMonthlyEarningsPolicySchema=z.object({
  timezone:accountingPeriodPolicySchema.shape.timezone,
  proration:z.enum(["FULL_CALENDAR_MONTH_ONLY","COMPLETE_ELIGIBLE_CALENDAR_DAYS"]),
  rate_selection:z.enum(["AT_FIRST_ELIGIBLE_DAY","DAILY_EFFECTIVE"]),
  rounding:z.literal("HALF_UP_AT_PERIOD_TOTAL")
}).strict();

export function employeeMonthlyEarningsWindow(month:string,rawPolicy:unknown){
  const policy=employeeMonthlyEarningsPolicySchema.parse(rawPolicy),first=z.iso.date().parse(month+"-01"),cursor=new Date(first+"T00:00:00.000Z");
  const dates:string[]=[];do{dates.push(cursor.toISOString().slice(0,10));cursor.setUTCDate(cursor.getUTCDate()+1);}while(cursor.toISOString().slice(0,7)===month);
  const endOn=cursor.toISOString().slice(0,10),points=[...dates,endOn].map(on=>calendarDateStart(on,policy.timezone));
  return{month,policy,fromOn:first,toOn:dates.at(-1)!,startsAt:points[0],endsAt:points.at(-1)!,days:dates.map((on,index)=>({on,startsAt:points[index],endsAt:points[index+1]}))};
}

type EligibleDay={on:string;eligible:boolean;rate:Money|null};
/** Repository-validated whole-day assignment coverage and effective contracts feed one exact period calculation. */
export function employeeMonthlyEarnedAmount(month:string,rawPolicy:unknown,currency:string,sourceDays:readonly EligibleDay[]){
  return employeeMonthlyEarnedAmountForWindow(employeeMonthlyEarningsWindow(month,rawPolicy),currency,sourceDays);
}

/** A batch shares its validated calendar; rates and eligibility are still evaluated independently for every source. */
export function employeeMonthlyEarnedAmountForWindow(window:ReturnType<typeof employeeMonthlyEarningsWindow>,currency:string,sourceDays:readonly EligibleDay[]){
  const byDate=new Map(sourceDays.map(day=>[day.on,day]));
  if(byDate.size!==sourceDays.length||sourceDays.length!==window.days.length||window.days.some(day=>!byDate.has(day.on)))throw new EmployeeCompensationBasisError("Monthly earnings require every actual calendar day exactly once");
  const days=window.days.map(day=>byDate.get(day.on)!),eligible=days.filter(day=>day.eligible);
  if(!eligible.length||window.policy.proration==="FULL_CALENDAR_MONTH_ONLY"&&eligible.length!==days.length)throw new EmployeeCompensationBasisError("The configured monthly coverage is not satisfied");
  if(eligible.some(day=>!day.rate||day.rate.currency!==currency||day.rate.amount.lt(0)))throw new EmployeeCompensationBasisError("Monthly earnings require the actual nonnegative same-currency contract");
  let weighted=Money.zero(currency);for(const day of eligible){const rate=window.policy.rate_selection==="AT_FIRST_ELIGIBLE_DAY"?eligible[0].rate!:day.rate!;weighted=weighted.add(rate);}
  return{amount:weighted.multiplyRatio(1n,BigInt(days.length)),eligibleDays:eligible.length,calendarDays:days.length,window};
}
