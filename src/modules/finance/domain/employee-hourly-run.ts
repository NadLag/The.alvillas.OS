import { z } from "zod";
import { employeeCompensationRunPolicySchema } from "./employee-compensation-run";
export const employeeHourlyRunPolicyKey="staff.compensation_hourly_runs";
export const employeeHourlyRunPolicySchema=employeeCompensationRunPolicySchema.extend({earning_unit:z.literal("VALIDATED_COMPLETED_WORK_SOURCE"),rounding:z.literal("HALF_UP_AT_EARNING_TOTAL"),overlap_between_sources:z.enum(["REJECT_PER_PERSON","ALLOW_PER_VALIDATED_SOURCE"])}).strict();
const id=z.uuid().transform(value=>value.toLowerCase());
export const employeeHourlyRunSourceInput=z.object({
 fromOn:z.iso.date(),toOn:z.iso.date(),currency:z.string().regex(/^[A-Z]{3}$/u),
 jobs:z.array(z.object({taskId:id,assignmentId:id,evidenceId:id,decisionId:id,confirmedAssignment:z.literal(true)}).strict()).min(1).max(10000)
}).strict().superRefine((value,ctx)=>{
 if(value.fromOn>value.toOn)ctx.addIssue({code:"custom",path:["toOn"],message:"Run period must be ordered"});
 if(new Set(value.jobs.map(job=>job.taskId)).size!==value.jobs.length||new Set(value.jobs.map(job=>job.evidenceId)).size!==value.jobs.length)
  ctx.addIssue({code:"custom",path:["jobs"],message:"Each actual completed-work source belongs once in a run"});
});
export const employeeHourlyRunCreateInput=employeeHourlyRunSourceInput.safeExtend({purpose:z.string().trim().min(3).max(1000),reason:z.string().trim().min(6).max(500),idempotencyKey:id});
