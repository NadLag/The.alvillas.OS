import {randomUUID} from "node:crypto";
import {guestDepositCommandSchema,guestDepositCommandSuccessSchema,guestDepositCommandResultSchema,guestDepositCommandRecoverySchema,guestDepositRecoveryInput} from "../domain/guest-deposit-command";
import {GuestDepositConflictError,GuestDepositConfigurationError,GuestDepositSourceError} from "../domain/guest-deposit";
import {AccountingPeriodClosedError} from "../domain/accounting-period";
import {postGuestDepositReceipt,postGuestDepositRefund,reverseGuestDepositMovement,recoverGuestDepositCommand} from "./guest-deposit-service";
import {admitGuestDepositCash} from "./guest-deposit-cash-service";
import type {FinanceActorContext} from "./finance-access";
import type {TenantTransactionRunner} from "@/platform/db/tenant";
type Deps={db?:TenantTransactionRunner;requestId?:string};
export async function executeGuestDepositCommand(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const command=guestDepositCommandSchema.parse(raw),input={...command.input,idempotencyKey:command.idempotencyKey},result=command.operation==="RECEIPT"?await postGuestDepositReceipt(ctx,input,deps):command.operation==="ADMIT_CASH"?await admitGuestDepositCash(ctx,input,deps):command.operation==="REFUND"?await postGuestDepositRefund(ctx,input,deps):await reverseGuestDepositMovement(ctx,input,deps);
 if(result.operation!==command.operation)throw new GuestDepositConflictError();return guestDepositCommandSuccessSchema.parse({...result,requestId:command.idempotencyKey,idempotencyKey:command.idempotencyKey,state:"SUCCEEDED",failureCode:null});
}
/** Only known native rollbacks produce a terminal receipt; unknown outcomes require original-nonce recovery. */
export async function requestGuestDepositCommand(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const command=guestDepositCommandSchema.parse(raw);try{return await executeGuestDepositCommand(ctx,command,deps);}catch(error){
  const base={requestId:deps.requestId??randomUUID(),idempotencyKey:command.idempotencyKey,operation:command.operation};
  if(error instanceof GuestDepositConflictError){const original=await recoverGuestDepositCommand(ctx,{key:command.idempotencyKey},deps);return guestDepositCommandResultSchema.parse({...base,state:"CONFLICT",failureCode:original.request?"ORIGINAL_REQUEST_RECORDED":"SOURCE_CHANGED"});}
  const failureCode=error instanceof GuestDepositConfigurationError?"CONFIGURATION_UNAVAILABLE":error instanceof GuestDepositSourceError?"SOURCE_UNAVAILABLE":error instanceof AccountingPeriodClosedError?"PERIOD_CLOSED":null;
  if(failureCode)return guestDepositCommandResultSchema.parse({...base,state:"FAILED",failureCode});throw error;
 }
}
export async function recoverGuestDepositCommandReceipt(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=guestDepositRecoveryInput.parse(raw),result=await recoverGuestDepositCommand(ctx,input,deps);return guestDepositCommandRecoverySchema.parse({request:result.request?{...result.request,requestId:input.key,idempotencyKey:input.key,state:"SUCCEEDED",failureCode:null}:null});
}
