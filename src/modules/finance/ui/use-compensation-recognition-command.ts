"use client";
import { useCallback } from "react";
import type { z } from "zod";
import { employeeCompensationRecognitionInput,employeeCompensationRecognitionRequestViewSchema } from "../domain/employee-compensation-recognition-command";
import { useCompensationCommand } from "./use-compensation-command";
type Receipt=z.infer<typeof employeeCompensationRecognitionRequestViewSchema>;
const statusPath=(id:string)=>`/api/finance/compensation/recognition-requests/${id}`;
export function useCompensationRecognitionCommand({submissionId,claimId,scope,onSuccess,onInvalidate}:{submissionId:string;claimId:string;scope:string;onSuccess:()=>void;onInvalidate:()=>void}){
  const accept=useCallback((receipt:Receipt)=>receipt.submissionId===submissionId&&receipt.claimId===claimId&&(receipt.state!=="SUCCEEDED"||receipt.recognitionId!==null),[claimId,submissionId]);
  const recoveryInput=useCallback((key:string)=>({id:submissionId,claimId,key}),[claimId,submissionId]);
  return useCompensationCommand({storageKey:"alvillas.compensation.recognition.pending.v1."+scope,inputSchema:employeeCompensationRecognitionInput,receiptSchema:employeeCompensationRecognitionRequestViewSchema,requestPath:"/api/finance/compensation/recognitions",recoveryPath:"/api/finance/compensation/recognition-requests/recover",statusPath,recoveryInput,accept,onSuccess,onInvalidate});
}
