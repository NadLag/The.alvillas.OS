import { z } from "zod";
import { employeeCompensationSubmissionViewSchema } from "./employee-compensation-claim";
import { employeeCompensationCostDetailSchema } from "./employee-compensation-cost-workspace";
import { employeeCompensationRecognitionRequestViewSchema } from "./employee-compensation-recognition-command";

const id=z.uuid().transform(value=>value.toLowerCase());
export const employeeCompensationClaimWorkspaceInput=z.object({id,after:id.optional()}).strict();
export const employeeCompensationClaimDetailInput=z.object({id,claimId:id,after:id.optional(),beforeRequest:id.optional()}).strict();
const source=employeeCompensationSubmissionViewSchema.pick({id:true,runId:true,purpose:true,state:true,costOn:true,total:true});
const summary=z.object({id:z.uuid(),personId:z.uuid(),personName:z.string().nullable(),amount:employeeCompensationSubmissionViewSchema.shape.total,costCount:z.number().int().positive(),recognized:z.boolean(),pending:z.boolean(),canOpen:z.boolean()}).strict();
export const employeeCompensationClaimWorkspaceSchema=z.object({source,claims:z.array(summary).max(10),claimCount:z.number().int().positive(),next:z.uuid().nullable()}).strict();
export const employeeCompensationClaimDetailSchema=z.object({source,claim:summary,costs:employeeCompensationCostDetailSchema.shape.costs,labels:employeeCompensationCostDetailSchema.shape.labels,next:z.uuid().nullable(),
  recognition:z.object({id:z.uuid(),at:z.iso.datetime(),reason:z.string(),journalCount:z.number().int().positive(),lines:z.array(z.object({costId:z.uuid(),transactionId:z.uuid(),sourceOccurredAt:z.iso.datetime(),postedAt:z.iso.datetime()}).strict()).max(50)}).strict().nullable(),
  canRequest:z.boolean(),currentPeriod:z.boolean(),blocked:z.enum(["pending_approval","rejected","withdrawn","run_cancelled","already_recognized","request_pending","posting_forbidden","period_closed"]).nullable(),
  ownPending:employeeCompensationRecognitionRequestViewSchema.nullable(),history:z.array(z.object({requestId:z.uuid(),at:z.iso.datetime(),reason:z.string(),state:employeeCompensationRecognitionRequestViewSchema.shape.state,failureCode:employeeCompensationRecognitionRequestViewSchema.shape.failureCode}).strict()).max(10),nextRequest:z.uuid().nullable()
}).strict();
