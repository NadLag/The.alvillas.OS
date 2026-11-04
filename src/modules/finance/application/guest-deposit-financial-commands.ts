import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {guestDepositRecoveryInput,guestDepositReversalInput,guestDepositReversalReviewInput} from "../domain/guest-deposit-command";
import {guestDepositFundedApplicationSnapshot,guestDepositFundedApplicationReversalSnapshot} from "../domain/guest-deposit-funded-application-snapshot";
import {GuestDepositSourceError} from "../domain/guest-deposit";
import {GuestDepositRepository} from "../infrastructure/guest-deposit-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {reverseGuestDepositMovement as reverseReceipt,reviewGuestDepositReversal as reviewReceipt,recoverGuestDepositCommand as recoverReceipt} from "./guest-deposit-service";
import {replayGuestAccommodationApplicationInTransaction} from "./guest-accommodation-application-service";
import {reverseGuestAccommodationApplication,reviewGuestAccommodationApplicationReversal,replayGuestAccommodationApplicationReversalInTransaction} from "./guest-accommodation-application-reversal";
import type {FinanceActorContext} from "./finance-access";
type Deps={db?:TenantTransactionRunner;requestId?:string};
const application=(ctx:FinanceActorContext,id:string,deps:Deps)=>withTenant(deps.db??prisma,ctx.organizationId,async tx=>Boolean(await new GuestDepositRepository(tx,ctx.organizationId).audit(id,"finance.guest_deposit.applied")));
export async function reviewGuestDepositReversal(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=guestDepositReversalReviewInput.parse(raw);return await application(ctx,input.transactionId,deps)?reviewGuestAccommodationApplicationReversal(ctx,input,deps):reviewReceipt(ctx,input,deps);}
export async function reverseGuestDepositMovement(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=guestDepositReversalInput.parse(raw);return await application(ctx,input.transactionId,deps)?reverseGuestAccommodationApplication(ctx,input,deps):reverseReceipt(ctx,input,deps);}
export async function recoverGuestDepositCommand(context:FinanceActorContext,raw:unknown,deps:Deps={}){
 const ctx={...context,authContext:restoreAuthorizationCap(captureAuthorizationCap(context.authContext))},input=guestDepositRecoveryInput.parse(raw),recovered=await withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new GuestDepositRepository(tx,ctx.organizationId);await repository.lockCommand(input.key);const row=await repository.byCommand(input.key);if(!row)return null;const audit=await repository.commandAudit(row.id),applied=guestDepositFundedApplicationSnapshot.safeParse(audit?.after),reversed=guestDepositFundedApplicationReversalSnapshot.safeParse(audit?.after),saved=applied.success?applied.data:reversed.success?reversed.data:null;if(!saved)return null;
  const replay=applied.success?replayGuestAccommodationApplicationInTransaction:replayGuestAccommodationApplicationReversalInTransaction,request=await replay(ctx,input.key,saved.commandHash,tx);if(!request)throw new GuestDepositSourceError();await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.guest_deposit.command_recovered",resourceType:"financial_transaction",resourceId:row.id,after:{depositId:request.depositId,operation:request.operation,idempotencyKey:input.key},reason:"Recovered original actor-bound guest deposit command",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await new FinanceRepository(tx,ctx.organizationId).clock()});await replay(ctx,input.key,saved.commandHash,tx);return{request};
 });return recovered??recoverReceipt(ctx,input,deps);
}
