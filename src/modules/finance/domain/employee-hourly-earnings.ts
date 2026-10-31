import { z } from "zod";
import { Money } from "@/platform/money/money";
import { EmployeeCompensationBasisError } from "./employee-compensation";

const seconds=z.string().regex(/^[1-9]\d{0,29}$/u);
export const employeeHourlyEarningsPolicyKey="staff.compensation_hourly_earnings";
export const employeeHourlyEarningsPolicySchema=z.object({
  evidence:z.literal("VALIDATED_COMPLETED_WORK_INTERVALS"),
  rate_selection:z.literal("ACTUAL_EFFECTIVE_INSTANTS"),
  rounding:z.literal("HALF_UP_AT_EARNING_TOTAL"),
  max_interval_seconds:seconds,max_total_seconds:seconds,require_distinct_validator:z.boolean()
}).strict();

export type EmployeeHourlyRateSlice={startsAt:Date;endsAt:Date;rate:Money};
export type EmployeeHourlyInterval={id:string;startsAt:Date;endsAt:Date;performedByPersonId:string;validatedByPersonId:string;slices:readonly EmployeeHourlyRateSlice[]};
const denied=()=>new EmployeeCompensationBasisError("Hourly earnings require complete, nonoverlapping, validated actual intervals and original effective rates");
function instant(value:Date){const time=value.getTime();if(!Number.isSafeInteger(time))throw denied();return BigInt(time);}

/** Actual repositories supply retained interval/rate witnesses; planned schedule duration is never an earning input. */
export function employeeHourlyEarnedAmount(rawPolicy:unknown,currency:string,completedAt:Date,intervals:readonly EmployeeHourlyInterval[]){
  const policy=employeeHourlyEarningsPolicySchema.parse(rawPolicy),completion=instant(completedAt);
  if(!intervals.length||new Set(intervals.map(interval=>interval.id)).size!==intervals.length)throw denied();
  const ordered=[...intervals].sort((a,b)=>a.startsAt.getTime()-b.startsAt.getTime());
  let total=0n,weighted=Money.zero(currency),previousEnd:bigint|null=null,performer:string|null=null;
  for(const interval of ordered){
    const start=instant(interval.startsAt),end=instant(interval.endsAt),duration=end-start;
    if(!interval.id||!interval.performedByPersonId||!interval.validatedByPersonId||duration<=0n||end>completion||previousEnd!==null&&start<previousEnd||
      duration>BigInt(policy.max_interval_seconds)*1000n||performer!==null&&performer!==interval.performedByPersonId||
      policy.require_distinct_validator&&interval.performedByPersonId===interval.validatedByPersonId)throw denied();
    performer=interval.performedByPersonId;previousEnd=end;total+=duration;
    if(total>BigInt(policy.max_total_seconds)*1000n)throw denied();
    let covered=start;
    for(const slice of interval.slices){
      const sliceStart=instant(slice.startsAt),sliceEnd=instant(slice.endsAt);
      if(sliceStart!==covered||sliceEnd<=sliceStart||sliceEnd>end||slice.rate.currency!==currency||slice.rate.amount.isNegative())throw denied();
      weighted=weighted.add(slice.rate.multiplyRatio(sliceEnd-sliceStart,1n));covered=sliceEnd;
    }
    if(covered!==end)throw denied();
  }
  const fraction=(total%1000n).toString().padStart(3,"0").replace(/0+$/u,"");
  return{amount:weighted.multiplyRatio(1n,3600000n),milliseconds:total.toString(),seconds:(total/1000n).toString()+(fraction?"."+fraction:"")};
}
