import { z } from "zod";

const id=z.uuid().transform(value=>value.toLowerCase());
const money=z.object({amount:z.string().max(128).regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
export const employeeMonthlyRunSourceInput=z.object({month:z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u),currency:z.string().regex(/^[A-Z]{3}$/u),assignments:z.array(z.object({assignmentId:id,confirmedAssignment:z.literal(true)}).strict()).min(1).max(10000)}).strict().refine(input=>new Set(input.assignments.map(row=>row.assignmentId)).size===input.assignments.length);
export const employeeMonthlyRunCreateInput=employeeMonthlyRunSourceInput.safeExtend({purpose:z.string().trim().min(3).max(1000),reason:z.string().trim().min(6).max(500),idempotencyKey:id});
export const employeeMonthlyRunRequestInput=employeeMonthlyRunCreateInput.safeExtend({reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)});
export const employeeMonthlyOriginalSourceSchema=z.object({assignmentId:id,personId:id,scopeType:z.enum(["organization","property","city","region","job"]),scopeId:id.nullable(),days:z.array(z.object({on:z.iso.date(),compensationId:id.nullable()}).strict()).min(28).max(31)}).strict();
export const employeeMonthlyRunRequestReviewSchema=z.object({amount:money,beneficiaries:z.array(z.object({personId:id,amount:money}).strict()).min(1).max(10000),sources:z.array(employeeMonthlyOriginalSourceSchema).min(1).max(10000).optional()}).strict();
export const employeeMonthlyRunRequestViewSchema=z.object({requestId:id,idempotencyKey:id,state:z.enum(["PENDING","SUCCEEDED","DENIED","CONFLICT","FAILED"]),runId:id.nullable(),failureCode:z.enum(["ACCESS_DENIED","SOURCE_CHANGED","POLICY_UNAVAILABLE","EXECUTION_UNAVAILABLE"]).nullable(),idempotent:z.boolean()}).strict().superRefine((value,ctx)=>{
  const valid=value.state==="PENDING"?value.runId===null&&value.failureCode===null:value.state==="SUCCEEDED"?value.runId!==null&&value.failureCode===null:value.runId===null&&(value.state==="DENIED"?value.failureCode==="ACCESS_DENIED":value.state==="FAILED"?value.failureCode==="EXECUTION_UNAVAILABLE":value.failureCode==="SOURCE_CHANGED"||value.failureCode==="POLICY_UNAVAILABLE");
  if(!valid)ctx.addIssue({code:"custom",message:"Request outcome must match its actual terminal source"});
});
