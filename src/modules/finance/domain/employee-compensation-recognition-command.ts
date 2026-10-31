import { z } from "zod";

export const employeeCompensationRecognitionInput=z.object({id:z.uuid().transform(value=>value.toLowerCase()),claimId:z.uuid().transform(value=>value.toLowerCase()),
  idempotencyKey:z.uuid().transform(value=>value.toLowerCase()),reason:z.string().trim().min(6).max(500),currentPeriod:z.boolean().default(false)}).strict();
export const employeeCompensationRecognitionRequestViewSchema=z.object({requestId:z.uuid(),submissionId:z.uuid(),claimId:z.uuid(),state:z.enum(["PENDING","SUCCEEDED","DENIED","CONFLICT","FAILED"]),
  recognitionId:z.uuid().nullable(),failureCode:z.enum(["ACCESS_DENIED","SOURCE_CHANGED","POLICY_UNAVAILABLE","PERIOD_CLOSED","EXECUTION_UNAVAILABLE"]).nullable(),idempotent:z.boolean()}).strict();
