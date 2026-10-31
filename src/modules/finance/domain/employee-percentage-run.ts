import {z} from "zod";
import {employeeCompensationRunPolicySchema,employeeCompensationRunWindow} from "./employee-compensation-run";

export const employeePercentageRunPolicyKey="staff.compensation_percentage_runs";
export const employeePercentageRunPolicySchema=employeeCompensationRunPolicySchema.omit({earning_date:true}).extend({
 earning_date:z.literal("ACTUAL_POSTED_FINANCIAL_BASE"),earning_unit:z.literal("PERSON_ASSIGNMENT_SELECTED_POSTINGS")
}).strict();
const id=z.uuid().transform(value=>value.toLowerCase());
export const employeePercentageSourceInput=z.object({currency:z.string().regex(/^[A-Z]{3}$/u),bases:z.array(z.object({postingId:id,assignmentId:id}).strict()).min(1).max(10000)}).strict()
 .refine(input=>new Set(input.bases.map(base=>base.postingId+":"+base.assignmentId)).size===input.bases.length);
export const employeePercentageRunSourceInput=employeePercentageSourceInput.safeExtend({fromOn:z.iso.date(),toOn:z.iso.date()}).superRefine((input,ctx)=>{
 if(input.fromOn>input.toOn)ctx.addIssue({code:"custom",path:["toOn"],message:"Run period must be ordered"});
});

export const employeePercentageRunCreateInput=employeePercentageRunSourceInput.safeExtend({purpose:z.string().trim().min(3).max(1000),reason:z.string().trim().min(6).max(500),idempotencyKey:id});

/** Reuse calendar conversion; source eligibility is always checked against actual posting instants. */
export function employeePercentageRunWindow(fromOn:string,toOn:string,rawPolicy:unknown){
 const policy=employeePercentageRunPolicySchema.parse(rawPolicy),window=employeeCompensationRunWindow(fromOn,toOn,{earning_date:"RECORDED_COMPLETION",timezone:policy.timezone,max_period_days:policy.max_period_days});
 return{...window,policy};
}
