import { z } from "zod";
import { Money } from "@/platform/money/money";

const id=z.uuid().transform(value=>value.toLowerCase());
export const employeeCompensationClaimPolicyInput=z.object({runId:id,costOn:z.iso.date(),emergency:z.boolean(),
  costs:z.array(z.object({runLineId:id,category:z.string().trim().min(1).max(120),costCenter:z.string().trim().min(1).max(120).nullable(),note:z.string().trim().min(6).max(1000)}).strict()).min(1).max(10000)
}).strict().superRefine((input,ctx)=>{if(new Set(input.costs.map(cost=>cost.runLineId)).size!==input.costs.length)ctx.addIssue({code:"custom",path:["costs"],message:"Every retained work source has one explicit cost classification"});});
export class EmployeeCompensationClaimSourceError extends Error{}
export const employeeCompensationSubmissionInput=z.object({...employeeCompensationClaimPolicyInput.shape,idempotencyKey:id,reason:z.string().trim().min(6).max(500)}).strict()
  .refine(input=>new Set(input.costs.map(cost=>cost.runLineId)).size===input.costs.length);
export const employeeCompensationSubmissionRequestViewSchema=z.object({requestId:id,runId:id,state:z.enum(["PENDING","SUCCEEDED","DENIED","CONFLICT","FAILED"]),submissionId:id.nullable(),
  failureCode:z.enum(["ACCESS_DENIED","SOURCE_CHANGED","POLICY_UNAVAILABLE","EXECUTION_UNAVAILABLE"]).nullable(),idempotent:z.boolean()}).strict()
  .refine(value=>value.state==="PENDING"?value.submissionId===null&&value.failureCode===null:value.state==="SUCCEEDED"?value.submissionId!==null&&value.failureCode===null:value.submissionId===null&&value.failureCode!==null);
const moneyView=z.object({amount:z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
export const employeeCompensationSubmissionViewSchema=z.object({id,runId:id,state:z.enum(["PENDING_APPROVAL","APPROVED","REJECTED","WITHDRAWN"]),purpose:z.string(),costOn:z.iso.date(),
  createdAt:z.iso.datetime(),total:moneyView,costCount:z.number().int().positive(),claimCount:z.number().int().positive(),approvalId:id.nullable(),canWithdraw:z.boolean(),
  costs:z.array(z.object({id,claimId:id,personId:id,runLineId:id,propertyId:id,reservationId:id.nullable(),completionEventId:id,amount:moneyView,
    category:z.string(),costCenter:z.string().nullable(),note:z.string(),allocation:z.object({owner:moneyView,alvillas:moneyView,guest:moneyView}).strict()}).strict()).max(50),
  nextCursor:id.nullable(),history:z.array(z.object({action:z.enum(["SUBMITTED","APPROVED","REJECTED","WITHDRAWN"]),at:z.iso.datetime(),reason:z.string()}).strict()).min(1).max(3)
}).strict();

/** Classification may select policy and an explicit cost date; original work amounts are immutable. */
export function employeeCompensationClaimCosts<T extends {id:string;currency:string;amount:{toString():string}}>(input:z.infer<typeof employeeCompensationClaimPolicyInput>,lines:readonly T[],currency:string){
  if(new Set(lines.map(line=>line.id)).size!==lines.length||new Set(input.costs.map(cost=>cost.runLineId)).size!==input.costs.length)throw new EmployeeCompensationClaimSourceError();
  const positive=lines.filter(line=>{const amount=Money.of(line.amount.toString(),currency);if(line.currency!==currency||amount.amount.lt(0))throw new EmployeeCompensationClaimSourceError();return amount.amount.gt(0);});
  const byId=new Map(positive.map(line=>[line.id,line]));
  if(!positive.length||input.costs.length!==positive.length)throw new EmployeeCompensationClaimSourceError();
  let total=Money.zero(currency);
  const costs=input.costs.map(cost=>{
    const source=byId.get(cost.runLineId);if(!source||source.currency!==currency)throw new EmployeeCompensationClaimSourceError();
    const amount=Money.of(source.amount.toString(),currency);if(!amount.amount.gt(0))throw new EmployeeCompensationClaimSourceError();total=total.add(amount);
    return{...cost,source,amount};
  });
  return{costs,total};
}
