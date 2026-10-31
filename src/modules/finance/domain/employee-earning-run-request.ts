import { z } from "zod";
import { employeeHourlyRunCreateInput } from "./employee-hourly-run";
export const employeeHourlyRunRequestInput=employeeHourlyRunCreateInput.safeExtend({reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)});
export const employeeEarningRunRequestViewSchema=z.object({requestId:z.uuid(),idempotencyKey:z.uuid(),state:z.enum(["PENDING","SUCCEEDED","DENIED","CONFLICT","FAILED"]),runId:z.uuid().nullable(),failureCode:z.enum(["ACCESS_DENIED","SOURCE_CHANGED","POLICY_UNAVAILABLE","EXECUTION_UNAVAILABLE"]).nullable(),idempotent:z.boolean()}).strict().refine(value=>value.state==="PENDING"?value.runId===null&&value.failureCode===null:value.state==="SUCCEEDED"?value.runId!==null&&value.failureCode===null:value.runId===null&&value.failureCode!==null);
