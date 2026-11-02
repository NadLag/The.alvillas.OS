"use client";
import {useCallback} from "react";
import {z} from "zod";
import {receivableCollectionInput,receivableCollectionVoidInput,receivableCollectionReceiptSchema} from "../domain/receivable-collection";
import {useCompensationCommand} from "./use-compensation-command";
const receiptSchema=receivableCollectionReceiptSchema.transform(value=>({...value,requestId:value.collection.id,state:"SUCCEEDED" as const,failureCode:null}));
const recoverySchema=z.union([z.object({collection:z.null()}).strict(),receiptSchema]).transform(value=>({request:"operation" in value?value:null}));
const recoveryInput=(key:string)=>({key});
type Receipt=z.infer<typeof receiptSchema>;
type Options={scope:string;id:string;onSuccess:(receipt:Receipt)=>void;onInvalidate:()=>void};
export function useReceivableCollectionCommand({scope,onSuccess,onInvalidate}:Options){
 const accept=useCallback((receipt:Receipt,input:z.infer<typeof receivableCollectionInput>|null,nonce:string|null)=>receipt.operation==="COLLECT"&&receipt.idempotencyKey===nonce&&(!input||receipt.collection.assignmentId===input.assignmentId),[]);
 return useCompensationCommand({storageKey:"alvillas.receivable.collection.pending.v1."+scope,inputSchema:receivableCollectionInput,receiptSchema,recoverySchema,requestPath:"/api/finance/receivables/collections",recoveryPath:"/api/finance/receivables/collections/recover",recoveryInput,accept,onSuccess,onInvalidate});
}
export function useReceivableCollectionReversalCommand({scope,onSuccess,onInvalidate}:Options){
 const accept=useCallback((receipt:Receipt,input:z.infer<typeof receivableCollectionVoidInput>|null,nonce:string|null)=>receipt.operation==="REVERSE"&&receipt.idempotencyKey===nonce&&(!input||receipt.collection.id===input.id)&&receipt.collection.reversal!==null,[]);
 return useCompensationCommand({storageKey:"alvillas.receivable.collection.correction.pending.v1."+scope,inputSchema:receivableCollectionVoidInput,receiptSchema,recoverySchema,requestPath:"/api/finance/receivables/collections/reverse",recoveryPath:"/api/finance/receivables/collections/recover",recoveryInput,accept,onSuccess,onInvalidate});
}
