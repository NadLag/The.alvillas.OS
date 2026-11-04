import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {Money} from "@/platform/money/money";
import {guestDepositFundedApplicationInput,guestDepositFundedApplicationReviewInput} from "../domain/guest-deposit-command";
import {guestDepositFundedApplicationSnapshot} from "../domain/guest-deposit-funded-application-snapshot";
import {GuestDepositAuthorizationError,GuestDepositConflictError,GuestDepositSourceError} from "../domain/guest-deposit";
import {GuestDepositRepository,guestDepositCommandKey} from "../infrastructure/guest-deposit-repository";
import {FinancialTransferRepository} from "../infrastructure/financial-transfer-repository";
import {GuestAccommodationApplicationRepository} from "../infrastructure/guest-accommodation-application-repository";
import {inspectGuestAccommodationApplication} from "./guest-accommodation-application-source";
import {lockGuestDepositPolicyInTransaction,readGuestDepositSourceInTransaction,resolveGuestDepositPolicyInTransaction,presentGuestDepositResult} from "./guest-deposit-service";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
import type {FinancePostingDraft} from "../domain/reservation-revenue";

type Deps={db?:TenantTransactionRunner;requestId?:string};
const capture=(ctx:FinanceActorContext)=>({...ctx,authContext:restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext))});
const serialized=(rows:readonly FinancePostingDraft[])=>rows.filter(row=>!row.amount.amount.isZero()).map(row=>({...row,amount:row.amount.toJSON().amount,currency:row.amount.currency}));
const json=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
export {replay as replayGuestAccommodationApplicationInTransaction};

async function replay(ctx:FinanceActorContext,key:string,hash:string,tx:TenantTransaction){
 const repository=new GuestDepositRepository(tx,ctx.organizationId),row=await repository.byCommand(key);if(!row)return null;
 const audit=await repository.commandAudit(row.id);
 if(!audit||row.createdBy!==ctx.actorId||audit.actorId!==ctx.actorId)throw new GuestDepositAuthorizationError();
 const saved=guestDepositFundedApplicationSnapshot.safeParse(audit.after);if(!saved.success||saved.data.commandHash!==hash)throw new GuestDepositConflictError();
 const source=await readGuestDepositSourceInTransaction(ctx,saved.data.source.depositId,tx),target={...source.resource,id:row.id,financialRecordId:row.id,amount:saved.data.input.amount,occurredAt:row.occurredAt},checks=[...source.checks,{action:"view"as const,resource:target},...saved.data.originalOwnerOrder.map(ownerId=>({action:"view"as const,resource:{...target,ownerId}}))];
 await recheckFinanceAuthorization(ctx,tx,await source.finance.clock(),checks,new GuestDepositAuthorizationError());
 return presentGuestDepositResult(ctx,target,{id:row.id,depositId:saved.data.source.depositId,operation:"APPLY"as const,idempotent:true},await source.finance.clock());
}

export async function reviewGuestAccommodationApplication(context:FinanceActorContext,raw:unknown,deps:Deps={}){
 const ctx=capture(context),parsed=guestDepositFundedApplicationReviewInput.parse(raw),input={...parsed,amount:Money.of(parsed.amount,parsed.currency).toJSON().amount};
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const p=await inspectGuestAccommodationApplication(ctx,input,tx),result=presentGuestDepositResult(ctx,p.target,{depositId:input.depositId,amount:p.amount.toJSON(),outstanding:p.source.outstanding.toJSON(),quote:p.quote.toJSON(),applied:p.applied.toJSON(),commissionDelta:p.after.commission.subtract(p.before.commission).toJSON(),checkoutRevisionId:p.facts.checkout!.id,reviewFingerprint:p.fingerprint},p.now);
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.guest_deposit.application_reviewed",resourceType:"financial_transaction",resourceId:p.source.row.id,after:{depositId:input.depositId,reviewFingerprint:p.fingerprint},reason:"Reviewed original guest funds against actual native checkout",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await p.finance.clock()});
  if((await inspectGuestAccommodationApplication(ctx,input,tx)).fingerprint!==p.fingerprint)throw new GuestDepositConflictError();return result;
 });
}

export async function applyGuestAccommodationDeposit(context:FinanceActorContext,raw:unknown,deps:Deps={}){
 const ctx=capture(context),parsed=guestDepositFundedApplicationInput.parse(raw),input={...parsed,amount:Money.of(parsed.amount,parsed.currency).toJSON().amount},hash=commandFingerprint({operation:"APPLY",input});
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new GuestDepositRepository(tx,ctx.organizationId);await repository.lockCommand(input.idempotencyKey);const existing=await replay(ctx,input.idempotencyKey,hash,tx);if(existing)return existing;
  const draft=guestDepositFundedApplicationReviewInput.strip().parse(input),hint=await inspectGuestAccommodationApplication(ctx,draft,tx);
  await hint.finance.lockReservationFinancialCorrection(hint.reservation.id);await new FinancialTransferRepository(tx,ctx.organizationId).lockAccounts([hint.source.liability.id,hint.ownerPayable.id,hint.commissionRevenue.id]);await hint.periods.lockPostingCalendar();await lockGuestDepositPolicyInTransaction(tx,ctx.organizationId,hint.reservation.propertyId,hint.now,hint.reservation.id);await repository.lockSource(input.depositId);
  const p=await inspectGuestAccommodationApplication(ctx,draft,tx);if(p.fingerprint!==input.reviewFingerprint)throw new GuestDepositConflictError();
  const postings=p.postings.map(row=>({...row,dimensions:{...row.dimensions,source:"GUEST_DEPOSIT",booking_source:p.reservation.source,application_source:"ORIGINAL_GUEST_PREPAYMENT",deposit_operation:"APPLICATION",deposit_id:input.depositId,deposit_kind:p.source.snapshot.source.kind,guest_id:p.source.snapshot.source.guestId,deposit_application_id:input.idempotencyKey,original_transaction_id:p.source.row.id}}));
  const row=await p.finance.createFinancialTransaction({reference:"GUEST_DEPOSIT_APPLICATION:"+input.idempotencyKey,description:input.reason,occurredAt:p.now,idempotencyKey:guestDepositCommandKey(input.idempotencyKey),createdBy:ctx.actorId,postings,recheckAuthorization:async()=>{if((await inspectGuestAccommodationApplication(ctx,draft,tx)).fingerprint!==p.fingerprint)throw new GuestDepositConflictError();}}),snapshot=guestDepositFundedApplicationSnapshot.parse({schemaVersion:1,operation:"APPLY",input,commandHash:hash,source:p.source.snapshot.source,policy:p.policy,liabilityAccountId:p.source.liability.id,originalTransactionId:p.source.row.id,checkoutRevisionId:p.facts.checkout!.id,confirmationRevisionId:p.facts.confirmation!.id,financialSnapshotId:p.facts.financialSnapshot.id,appliedBefore:p.applied.toJSON().amount,appliedAfter:p.applied.add(p.amount).toJSON().amount,ownerPayableAccountId:p.ownerPayable.id,commissionRevenueAccountId:p.commissionRevenue.id,nativeBefore:serialized(p.before.rows),nativeAfter:serialized(p.after.rows),originalOwnerOrder:p.reservation.owners.map(owner=>owner.ownerId)});
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.guest_deposit.applied",resourceType:"financial_transaction",resourceId:row.id,after:json(snapshot),reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await p.finance.clock()});await repository.flushGuards();
  const latest=await readGuestDepositSourceInTransaction(ctx,input.depositId,tx),position=await new GuestAccommodationApplicationRepository(tx,ctx.organizationId).position(p.reservation.id,input.currency);
  if(!latest.outstanding.equals(p.source.outstanding.subtract(p.amount))||!Money.of(position.applied,input.currency).equals(p.applied.add(p.amount))||commandFingerprint(await resolveGuestDepositPolicyInTransaction(tx,ctx.organizationId,p.reservation.propertyId,await p.finance.clock(),p.reservation.id))!==commandFingerprint(p.policy))throw new GuestDepositConflictError();
  await p.periods.assertPostingOpen(p.now);await p.periods.assertPostingOpen(p.facts.checkout!.createdAt);await recheckFinanceAuthorization(ctx,tx,await p.finance.clock(),p.checks,new GuestDepositAuthorizationError());
  if(row.postings.length!==postings.length)throw new GuestDepositSourceError();return presentGuestDepositResult(ctx,p.target,{id:row.id,depositId:input.depositId,operation:"APPLY"as const,idempotent:false},await p.finance.clock());
 });
}
