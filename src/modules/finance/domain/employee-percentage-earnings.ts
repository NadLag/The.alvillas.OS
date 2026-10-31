import { z } from "zod";
import { Money } from "@/platform/money/money";
import { EmployeeCompensationBasisError,employeeCompensationPercentageBasisPoints } from "./employee-compensation";

export const employeePercentageEarningsPolicyKey="staff.compensation_percentage_earnings";
export const employeePercentageEarningsPolicySchema=z.object({
  evidence:z.literal("IMMUTABLE_POSTED_FINANCIAL_BASES"),
  base_buckets:z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,119}$/u)).min(1).refine(values=>new Set(values).size===values.length),
  base_side:z.enum(["DEBIT","CREDIT"]),
  rate_selection:z.literal("AT_ACTUAL_BASE_INSTANT"),rounding:z.literal("HALF_UP_AT_EARNING_TOTAL")
}).strict();
export type EmployeePercentageBase={postingId:string;transactionId:string;bucket:string;side:"DEBIT"|"CREDIT";amount:Money;rate:Money};

/** Canonical source readers supply actual retained postings and effective contracts, never an entered base estimate. */
export function employeePercentageEarnedAmount(rawPolicy:unknown,currency:string,bases:readonly EmployeePercentageBase[]){
  const policy=employeePercentageEarningsPolicySchema.parse(rawPolicy);
  if(!bases.length||new Set(bases.map(base=>base.postingId)).size!==bases.length)throw new EmployeeCompensationBasisError("Percentage earnings require distinct actual financial base postings");
  let weighted=Money.zero(currency),baseTotal=Money.zero(currency);
  for(const base of bases){
    if(!base.postingId||!base.transactionId||!policy.base_buckets.includes(base.bucket)||base.side!==policy.base_side||
      base.amount.currency!==currency||base.rate.currency!==currency||!base.amount.amount.gt(0))throw new EmployeeCompensationBasisError("Percentage earnings require the configured positive same-currency actual base");
    weighted=weighted.add(base.amount.multiplyRatio(employeeCompensationPercentageBasisPoints(base.rate),1n));baseTotal=baseTotal.add(base.amount);
  }
  return{amount:weighted.multiplyRatio(1n,10000n),baseAmount:baseTotal};
}
