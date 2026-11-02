"use client";
import {useCallback} from "react";
import type {z} from "zod";
import {employeeCompensationCorrectionInput,employeeCompensationCorrectionRequestViewSchema} from "../domain/employee-compensation-correction";
import {useCompensationCommand} from "./use-compensation-command";
type Receipt=z.infer<typeof employeeCompensationCorrectionRequestViewSchema>;
const statusPath=(id:string)=>`/api/finance/compensation/correction-requests/${id}`;
export function useCompensationCorrectionCommand({submissionId,claimId,recognitionId,scope,onSuccess,onInvalidate}:{submissionId:string;claimId:string;recognitionId:string;scope:string;onSuccess:()=>void;onInvalidate:()=>void}){
 const accept=useCallback((receipt:Receipt)=>receipt.submissionId===submissionId&&receipt.claimId===claimId&&receipt.originalRecognitionId===recognitionId,[claimId,recognitionId,submissionId]);
 const recoveryInput=useCallback((key:string)=>({id:submissionId,claimId,key}),[claimId,submissionId]);
 return useCompensationCommand({storageKey:"alvillas.compensation.correction.pending.v1."+scope,inputSchema:employeeCompensationCorrectionInput,receiptSchema:employeeCompensationCorrectionRequestViewSchema,requestPath:"/api/finance/compensation/corrections",recoveryPath:"/api/finance/compensation/correction-requests/recover",statusPath,recoveryInput,accept,onSuccess,onInvalidate});
}
