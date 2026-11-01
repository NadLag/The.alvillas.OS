import {z} from "zod";
import {employeeCompensationRecognitionInput,employeeCompensationRecognitionRequestViewSchema} from "./employee-compensation-recognition-command";

/** Correction identifies immutable approved history; amount, beneficiary and posting dates are derived. */
export const employeeCompensationCorrectionInput=employeeCompensationRecognitionInput.omit({currentPeriod:true}).extend({recognitionId:z.uuid().transform(value=>value.toLowerCase())}).strict();
export const employeeCompensationCorrectionRecoveryInput=z.object({id:employeeCompensationRecognitionInput.shape.id,claimId:employeeCompensationRecognitionInput.shape.claimId,key:employeeCompensationRecognitionInput.shape.idempotencyKey}).strict();
export const employeeCompensationCorrectionRequestViewSchema=employeeCompensationRecognitionRequestViewSchema.omit({recognitionId:true}).extend({originalRecognitionId:z.uuid(),correctionId:z.uuid().nullable()}).strict().superRefine((receipt,ctx)=>{
 const succeeded=receipt.state==="SUCCEEDED",failed=["DENIED","CONFLICT","FAILED"].includes(receipt.state);
 if(succeeded!==(receipt.correctionId!==null)||failed!==(receipt.failureCode!==null))ctx.addIssue({code:"custom",message:"Correction acknowledgement must retain its actual terminal result"});
});
export const employeeCompensationCorrectionViewSchema=z.object({id:z.uuid(),claimId:z.uuid(),recognitionId:z.uuid(),correctionId:z.uuid(),originalTransactionIds:z.array(z.uuid()).min(1).max(10000),reversalTransactionIds:z.array(z.uuid()).min(1).max(10000),idempotent:z.boolean()}).strict().superRefine((receipt,ctx)=>{
 if(receipt.originalTransactionIds.length!==receipt.reversalTransactionIds.length||new Set(receipt.originalTransactionIds).size!==receipt.originalTransactionIds.length||new Set(receipt.reversalTransactionIds).size!==receipt.reversalTransactionIds.length||receipt.originalTransactionIds.some(id=>receipt.reversalTransactionIds.includes(id)))ctx.addIssue({code:"custom",message:"Correction must retain distinct original and opposite financial transactions"});
});
