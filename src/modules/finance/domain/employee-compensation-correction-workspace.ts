import {z} from "zod";
import {employeeCompensationClaimDetailSchema,employeeCompensationClaimDetailInput} from "./employee-compensation-claim-workspace";
import {employeeCompensationCorrectionRequestViewSchema} from "./employee-compensation-correction";

export const employeeCompensationCorrectionWorkspaceInput=employeeCompensationClaimDetailInput;
export const employeeCompensationCorrectionWorkspaceSchema=z.object({
 source:employeeCompensationClaimDetailSchema.shape.source,
 claim:employeeCompensationClaimDetailSchema.shape.claim,
 costs:employeeCompensationClaimDetailSchema.shape.costs,
 labels:employeeCompensationClaimDetailSchema.shape.labels,
 next:z.uuid().nullable(),
 recognition:employeeCompensationClaimDetailSchema.shape.recognition.unwrap(),
 outstanding:employeeCompensationClaimDetailSchema.shape.claim.shape.amount,
 correction:z.object({id:z.uuid(),at:z.iso.datetime(),reason:z.string(),journalCount:z.number().int().positive(),lines:z.array(z.object({costId:z.uuid(),originalTransactionId:z.uuid(),reversalTransactionId:z.uuid(),postedAt:z.iso.datetime()}).strict()).max(50)}).strict().nullable(),
 canRequest:z.boolean(),
 blocked:z.enum(["already_corrected","active_payments","request_pending","posting_forbidden","period_closed","source_changed","configuration_unavailable"]).nullable(),
 ownPending:employeeCompensationCorrectionRequestViewSchema.nullable(),
 history:z.array(z.object({requestId:z.uuid(),at:z.iso.datetime(),reason:z.string(),state:employeeCompensationCorrectionRequestViewSchema.shape.state,failureCode:employeeCompensationCorrectionRequestViewSchema.shape.failureCode,correctionId:z.uuid().nullable()}).strict()).max(10),
 nextRequest:z.uuid().nullable()
}).strict().superRefine((model,ctx)=>{if(model.canRequest!==(model.blocked===null)||model.correction&&model.canRequest)ctx.addIssue({code:"custom",message:"Correction eligibility must match its original financial source"});});
