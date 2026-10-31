"use client";
import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { employeeCompensationSubmissionInput,employeeCompensationSubmissionRequestViewSchema } from "../domain/employee-compensation-claim";
import { useCompensationCommand } from "./use-compensation-command";
type Receipt=z.infer<typeof employeeCompensationSubmissionRequestViewSchema>;
const statusPath=(id:string)=>`/api/finance/compensation/submission-requests/${id}`;
export function useCompensationCostCommand({locale,runId,scope,onInvalidate}:{locale:AppLocale;runId:string;scope:string;onInvalidate:()=>void}){
  const router=useRouter(),accept=useCallback((receipt:Receipt)=>receipt.runId===runId&&(receipt.state!=="SUCCEEDED"||receipt.submissionId!==null),[runId]);
  const onSuccess=useCallback((receipt:Receipt)=>{router.replace(`/${locale}/app/finance/compensation/proposals/${receipt.submissionId}`);},[locale,router]),recoveryInput=useCallback((key:string)=>({runId,key}),[runId]);
  const command=useCompensationCommand({storageKey:"alvillas.compensation.cost.pending.v1."+scope,inputSchema:employeeCompensationSubmissionInput,receiptSchema:employeeCompensationSubmissionRequestViewSchema,requestPath:"/api/finance/compensation/submissions",recoveryPath:"/api/finance/compensation/submission-requests/recover",statusPath,recoveryInput,accept,onSuccess,onInvalidate});
  return{...command,state:command.state==="succeeded"?"pending" as const:command.state};
}
