"use client";
import {useCallback} from "react";
import {z} from "zod";
import {receivableAssignmentCreateInput,receivableAssignmentReleaseInput,receivableAssignmentReceiptSchema} from "../domain/receivable-assignment";
import {useCompensationCommand} from "./use-compensation-command";
const receiptSchema=receivableAssignmentReceiptSchema.transform(value=>({...value,requestId:value.assignment.id,state:"SUCCEEDED" as const,failureCode:null}));
const recoverySchema=z.union([z.object({assignment:z.null()}).strict(),receiptSchema]).transform(value=>({request:"operation" in value?value:null}));
const recoveryInput=(key:string)=>({key});
type Receipt=z.infer<typeof receiptSchema>;
type Options={scope:string;onSuccess:(receipt:Receipt)=>void;onInvalidate:()=>void};
export function useReceivableCreateCommand({scope,onSuccess,onInvalidate}:Options){
 const accept=useCallback((receipt:Receipt,_input:unknown,nonce:string|null)=>receipt.operation==="ASSIGN"&&receipt.idempotencyKey===nonce,[]);
 return useCompensationCommand({storageKey:"alvillas.receivable.assignment.pending.v1."+scope,inputSchema:receivableAssignmentCreateInput,receiptSchema,recoverySchema,requestPath:"/api/finance/receivables/assignments",recoveryPath:"/api/finance/receivables/assignments/recover",recoveryInput,accept,onSuccess,onInvalidate});
}
export function useReceivableReleaseCommand({scope,id,onSuccess,onInvalidate}:Options&{id:string}){
 const accept=useCallback((receipt:Receipt,_input:unknown,nonce:string|null)=>receipt.operation==="RELEASE"&&receipt.idempotencyKey===nonce&&receipt.assignment.id===id&&receipt.assignment.release!==null,[id]);
 return useCompensationCommand({storageKey:"alvillas.receivable.release.pending.v1."+scope+"."+id,inputSchema:receivableAssignmentReleaseInput,receiptSchema,recoverySchema,requestPath:"/api/finance/receivables/assignments/release",recoveryPath:"/api/finance/receivables/assignments/recover",recoveryInput,accept,onSuccess,onInvalidate});
}
