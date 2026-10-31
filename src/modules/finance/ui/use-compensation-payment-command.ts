"use client";
import { useCallback } from "react";
import { z } from "zod";
import { employeeCompensationSettlementFormInput,employeeCompensationSettlementReceiptSchema } from "../domain/employee-compensation-settlement";
import { useCompensationCommand } from "./use-compensation-command";
const receiptSchema=employeeCompensationSettlementReceiptSchema.transform(value=>({...value,requestId:value.paymentId,state:"SUCCEEDED" as const,failureCode:null}));
const recoverySchema=z.object({payment:employeeCompensationSettlementReceiptSchema.nullable()}).strict().transform(value=>({request:value.payment?receiptSchema.parse(value.payment):null}));
type Receipt=z.infer<typeof receiptSchema>;
export function useCompensationPaymentCommand({submissionId,claimId,scope,onSuccess,onInvalidate}:{submissionId:string;claimId:string;scope:string;onSuccess:()=>void;onInvalidate:()=>void}){
  const accept=useCallback((receipt:Receipt)=>receipt.id===submissionId&&receipt.claimId===claimId,[claimId,submissionId]),recoveryInput=useCallback((key:string)=>({id:submissionId,claimId,key}),[claimId,submissionId]);
  return useCompensationCommand({storageKey:"alvillas.compensation.payment.pending.v1."+scope,inputSchema:employeeCompensationSettlementFormInput,receiptSchema,recoverySchema,requestPath:"/api/finance/compensation/settlements/from-local",recoveryPath:"/api/finance/compensation/settlements/recover",recoveryInput,accept,onSuccess,onInvalidate});
}
