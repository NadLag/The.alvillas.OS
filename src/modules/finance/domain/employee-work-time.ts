import { z } from "zod";
import { employeeHourlyEarningsPolicySchema } from "./employee-hourly-earnings";

const instant=z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString());
export const employeeWorkTimeIntervalSchema=z.object({startsAt:instant,endsAt:instant,note:z.string().trim().max(1000).nullable()}).strict();
export const employeeWorkTimeSubmitSchema=z.object({taskId:z.uuid(),previousEvidenceId:z.uuid().nullable(),kind:z.enum(["ACTUAL_INTERVALS","CANCELLATION"]),intervals:z.array(employeeWorkTimeIntervalSchema).max(1000),reason:z.string().trim().min(6).max(1000),idempotencyKey:z.uuid()}).strict();
export const employeeWorkTimeDecisionSchema=z.object({taskId:z.uuid(),evidenceId:z.uuid(),verdict:z.enum(["APPROVED","REJECTED"]),reason:z.string().trim().min(6).max(1000),idempotencyKey:z.uuid()}).strict();
export const employeeWorkTimeReadSchema=z.object({taskId:z.uuid(),beforeVersion:z.number().int().positive().optional()}).strict();
export const employeeWorkTimeRecoverySchema=z.object({taskId:z.uuid(),key:z.uuid(),operation:z.enum(["SUBMISSION","DECISION"])}).strict();
export const employeeWorkTimeEvidenceSchema=z.object({id:z.uuid(),version:z.number().int().positive(),kind:z.enum(["ACTUAL_INTERVALS","CANCELLATION"]),previousEvidenceId:z.uuid().nullable(),submittedAt:z.iso.datetime(),reason:z.string(),intervals:z.array(employeeWorkTimeIntervalSchema),decision:z.object({id:z.uuid(),verdict:z.enum(["APPROVED","REJECTED"]),reason:z.string(),decidedAt:z.iso.datetime()}).strict().nullable()}).strict();
export const employeeWorkTimeViewSchema=z.object({taskId:z.uuid(),completedAt:z.iso.datetime({offset:true}),latestEvidenceId:z.uuid().nullable(),canSubmit:z.boolean(),canValidate:z.boolean(),policy:employeeHourlyEarningsPolicySchema.nullable(),items:z.array(employeeWorkTimeEvidenceSchema).max(20),next:z.number().int().positive().nullable()}).strict();
export const employeeWorkTimeReceiptSchema=z.object({taskId:z.uuid(),operation:z.enum(["SUBMISSION","DECISION"]),idempotencyKey:z.uuid(),evidence:employeeWorkTimeEvidenceSchema,idempotent:z.boolean()}).strict();
export class EmployeeWorkTimeAccessError extends Error{}
export class EmployeeWorkTimeConflictError extends Error{}
export class EmployeeWorkTimePolicyError extends Error{}
export class EmployeeWorkTimeSourceError extends Error{}

/** Operational evidence validates actual instants without requiring access to a financial rate. */
export function validateEmployeeWorkTimeIntervals(rawPolicy:unknown,completedAt:Date,kind:"ACTUAL_INTERVALS"|"CANCELLATION",intervals:readonly {startsAt:string;endsAt:string}[]){
 const policy=employeeHourlyEarningsPolicySchema.parse(rawPolicy);
 if(kind==="CANCELLATION"){if(intervals.length)throw new EmployeeWorkTimeSourceError();return;}
 if(!intervals.length||!Number.isFinite(completedAt.getTime()))throw new EmployeeWorkTimeSourceError();
 let total=0n,end:bigint|null=null;
 for(const item of [...intervals].sort((a,b)=>a.startsAt.localeCompare(b.startsAt))){
  const start=BigInt(new Date(item.startsAt).getTime()),until=BigInt(new Date(item.endsAt).getTime()),duration=until-start;
  if(duration<=0n||until>BigInt(completedAt.getTime())||end!==null&&start<end||duration>BigInt(policy.max_interval_seconds)*1000n)throw new EmployeeWorkTimeSourceError();
  total+=duration;end=until;
 }
 if(total>BigInt(policy.max_total_seconds)*1000n)throw new EmployeeWorkTimeSourceError();
}
