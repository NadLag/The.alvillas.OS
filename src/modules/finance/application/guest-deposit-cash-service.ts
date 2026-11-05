import {z} from "zod";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {calendarDateAt} from "@/i18n/format";
import {lockWalletHolders} from "@/platform/ledger/wallet-lock";
import {guestDepositPolicyKey} from "@/platform/config/guest-deposit-policy";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {FinancialTransferRepository} from "../infrastructure/financial-transfer-repository";
import {GuestDepositRepository,guestDepositCommandKey} from "../infrastructure/guest-deposit-repository";
import {AccountingPeriodRepository} from "../infrastructure/accounting-period-repository";
import {guestDepositCashAdmissionReviewInput,guestDepositCashAdmissionInput} from "../domain/guest-deposit-command";
import {guestDepositCashAdmissionSnapshot} from "../domain/guest-deposit-snapshot";
import {guestDepositCashAdmissionPostings} from "../domain/guest-deposit-cash";
import {GuestDepositAuthorizationError,GuestDepositConfigurationError,GuestDepositConflictError,GuestDepositSourceError} from "../domain/guest-deposit";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
import {employeeSettlementFundingChecks} from "./employee-compensation-settlement";
import {readGuestDepositSourceInTransaction,resolveGuestDepositPolicyInTransaction,recoverGuestDepositCommand,presentGuestDepositResult} from "./guest-deposit-service";

import {reviewGuestPaymentMethod} from "./guest-deposit-payment-method";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Draft=z.infer<typeof guestDepositCashAdmissionReviewInput>;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value))as Prisma.InputJsonObject;
const denied=()=>new GuestDepositAuthorizationError();
const captured=(ctx:FinanceActorContext)=>({...ctx,authContext:restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext))});

async function prepare(ctx:FinanceActorContext,input:Draft,tx:TenantTransaction){
 const repository=new GuestDepositRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),periods=new AccountingPeriodRepository(tx,ctx.organizationId),now=await finance.clock(),booking=await repository.source(input.reservationId),cash=await repository.cashSource(input.collectionId),amount=Money.of(input.amount,input.currency);
 if(!booking?.guestId||!booking.linkedguestId||booking.linkedguestId.archivedAt||booking.property.archivedAt||!cash||cash.reservationId!==booking.id||cash.propertyId!==booking.propertyId||cash.currency!==amount.currency||cash.recordedAt>now)throw new GuestDepositSourceError();
 const resource={type:"financial_transaction",organizationId:ctx.organizationId,reservationId:booking.id,propertyId:booking.propertyId,guestId:booking.guestId,city:booking.property.cityId??booking.property.city,region:booking.property.regionId??booking.property.region,dataClass:"financial"as const,amount:amount.toJSON().amount,occurredAt:now},cashResource={...resource,type:"cash_collection",id:cash.id,financialRecordId:cash.transactionId,taskId:cash.taskId,jobId:cash.taskId,assignedPersonId:cash.collectorPersonId,assignedUserAccountId:cash.collectorUserAccountId,amount:cash.amount.toFixed(2),occurredAt:cash.recordedAt},checks:Array<Parameters<typeof recheckFinanceAuthorization>[3][number]>=[{action:"view",resource:cashResource},{action:"pay",resource:cashResource},{action:"view",resource},{action:"create",resource},{action:"pay",resource}];
 await recheckFinanceAuthorization(ctx,tx,now,checks,denied());
 const revision=await repository.cashBookingRevision(booking.id,cash.recordedAt),originalGuest=z.object({guestId:z.uuid(),propertyId:z.uuid()}).passthrough().safeParse(revision?.after);if(!originalGuest.success||originalGuest.data.guestId!==booking.guestId||originalGuest.data.propertyId!==booking.propertyId)throw new GuestDepositSourceError();
 const provenance=z.object({taskType:z.string(),taskVersion:z.number().int().positive(),reservationFinancialSnapshot:z.unknown()}).passthrough().safeParse(cash.provenance),original=cash.transaction,unallocated=original.postings.find(row=>row.ledgerAccount.code==="UNALLOCATED_COLLECTIONS"),custody=original.postings.find(row=>row.ledgerAccountId===cash.custodyAccountId);
 if(!provenance.success||!original.sealed||original.reversesTransactionId||original.reversedByTransactions.length||original.reference!=="CASH:"+cash.id||original.postings.length!==2||!unallocated||!custody||unallocated.side!=="CREDIT"||custody.side!=="DEBIT"||!Money.of(unallocated.amount.toString(),unallocated.currency).equals(Money.of(cash.amount.toString(),cash.currency))||!Money.of(custody.amount.toString(),custody.currency).equals(Money.of(cash.amount.toString(),cash.currency)))throw new GuestDepositSourceError();
 checks.push(...employeeSettlementFundingChecks(ctx,custody.ledgerAccount,amount.toJSON().amount,cash.recordedAt,"view"),...employeeSettlementFundingChecks(ctx,custody.ledgerAccount,amount.toJSON().amount,now,"pay"));await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,denied());
 const policy=await resolveGuestDepositPolicyInTransaction(tx,ctx.organizationId,booking.propertyId,now,booking.id),kind=policy.value.kinds.find(row=>row.key===input.kind),calendar=await periods.policy(now),currency=await new FinancialTransferRepository(tx,ctx.organizationId).currency(input.currency);
 if(!kind||!policy.value.cash_admission||!calendar||!currency||currency.minorUnit>2||amount.amount.decimalPlaces()>currency.minorUnit)throw new GuestDepositConfigurationError();
 await periods.assertPostingOpen(now);await periods.assertPostingOpen(cash.recordedAt);
 const liability=await finance.ensureLedgerAccount({code:kind.liability_account_code,name:kind.labels.en,accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),position=await repository.cashRemaining(cash.id,unallocated.ledgerAccountId,cash.currency),available=Money.of(position.amount,cash.currency),source={organizationId:ctx.organizationId,depositId:"00000000-0000-4000-8000-000000000000",reservationId:booking.id,propertyId:booking.propertyId,guestId:booking.guestId,kind:kind.key,city:resource.city,region:resource.region};
 guestDepositCashAdmissionPostings({source,collectionId:cash.id,collectionTransactionId:cash.transactionId,taskId:cash.taskId,taskType:provenance.data.taskType,unallocated:unallocated.ledgerAccount,liability,amount,available,policy:policy.value});
 const fingerprint=commandFingerprint({booking,cash:{...cash,revision:cash.revision.toString()},policy,calendar:{id:calendar.id,version:calendar.version,value:calendar.value},period:calendarDateAt(now,calendar.value.timezone).slice(0,7),liability,position,input});
 return{repository,finance,periods,now,booking,cash,unallocated,custody,liability,amount,available,policy,kind,source,checks,resource,fingerprint,taskType:provenance.data.taskType};
}

export async function reviewGuestDepositCashAdmission(context:FinanceActorContext,raw:unknown,deps:Deps={}){
 const ctx=captured(context),parsed=guestDepositCashAdmissionReviewInput.parse(raw),input={...parsed,amount:Money.of(parsed.amount,parsed.currency).toJSON().amount};
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{const p=await prepare(ctx,input,tx),method=await reviewGuestPaymentMethod(tx,ctx.organizationId,input.reservationId,await p.finance.clock(),p.amount,input.paymentMethodKey,["cash"]);await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.guest_deposit.cash_admission_reviewed",resourceType:"cash_collection",resourceId:p.cash.id,after:{collectionId:p.cash.id,reviewFingerprint:p.fingerprint},reason:"Reviewed ownership admission from the original actual cash collection",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await p.finance.clock()});if((await prepare(ctx,input,tx)).fingerprint!==p.fingerprint||(await reviewGuestPaymentMethod(tx,ctx.organizationId,input.reservationId,await p.finance.clock(),p.amount,input.paymentMethodKey,["cash"]))?.fingerprint!==method?.fingerprint)throw new GuestDepositConflictError();return presentGuestDepositResult(ctx,p.resource,{collectionId:p.cash.id,reservationId:p.booking.id,kind:p.kind,amount:p.amount.toJSON(),available:p.available.toJSON(),receivedAt:p.cash.recordedAt.toISOString(),custody:{id:p.custody.ledgerAccount.id,name:p.custody.ledgerAccount.name,code:p.custody.ledgerAccount.code},reviewFingerprint:p.fingerprint,...method?{paymentMethodFingerprint:method.fingerprint,paymentMethod:{key:method.method.key,labels:method.method.labels}}:{}},await p.finance.clock());});
}

export async function admitGuestDepositCash(context:FinanceActorContext,raw:unknown,deps:Deps={}){
 const ctx=captured(context),parsed=guestDepositCashAdmissionInput.parse(raw),input={...parsed,amount:Money.of(parsed.amount,parsed.currency).toJSON().amount},hash=commandFingerprint({operation:"ADMIT_CASH",input});
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new GuestDepositRepository(tx,ctx.organizationId);await repository.lockCommand(input.idempotencyKey);const existing=await repository.byCommand(input.idempotencyKey);
  if(existing){const audit=await repository.commandAudit(existing.id),saved=guestDepositCashAdmissionSnapshot.safeParse(audit?.after);if(existing.createdBy!==ctx.actorId||audit?.actorId!==ctx.actorId)throw denied();if(!saved.success||saved.data.commandHash!==hash)throw new GuestDepositConflictError();const original=await readGuestDepositSourceInTransaction(ctx,input.idempotencyKey,tx);return{id:original.row.id,depositId:input.idempotencyKey,operation:"ADMIT_CASH"as const,idempotent:true};}
  const draft=guestDepositCashAdmissionReviewInput.strip().parse(input),hint=await prepare(ctx,draft,tx),transfer=new FinancialTransferRepository(tx,ctx.organizationId);await hint.finance.lockReservationFinancialCorrection(input.reservationId);await lockWalletHolders(tx,ctx.organizationId,[hint.cash.collectorPersonId]);await transfer.lockAccounts([hint.unallocated.ledgerAccountId,hint.liability.id,hint.custody.ledgerAccountId]);await hint.periods.lockPostingCalendar();
  const scopeSource=await repository.policySource(input.reservationId);if(!scopeSource)throw new GuestDepositSourceError();const scopes=await new ReservationConfigScopeRepository(tx,ctx.organizationId).scopes({propertyId:hint.booking.propertyId,asOf:hint.now,source:scopeSource.source});for(const scope of scopes.sort((a,b)=>(a.scopeType+":"+(a.scopeId??"")).localeCompare(b.scopeType+":"+(b.scopeId??""))))await new ConfigRuleRepository(tx,ctx.organizationId).lockVersion(guestDepositPolicyKey,scope.scopeType,scope.scopeId);
  await transfer.lock("cash-source:"+input.collectionId);await repository.lockSource(input.idempotencyKey);
  const p=await prepare(ctx,draft,tx);if(p.fingerprint!==input.reviewFingerprint)throw new GuestDepositConflictError();const source={...p.source,depositId:input.idempotencyKey},row=await p.finance.createFinancialTransaction({reference:"GUEST_DEPOSIT:"+input.idempotencyKey,description:input.purpose,occurredAt:p.now,idempotencyKey:guestDepositCommandKey(input.idempotencyKey),createdBy:ctx.actorId,postings:guestDepositCashAdmissionPostings({source,collectionId:p.cash.id,collectionTransactionId:p.cash.transactionId,taskId:p.cash.taskId,taskType:p.taskType,unallocated:p.unallocated.ledgerAccount,liability:p.liability,amount:p.amount,available:p.available,policy:p.policy.value}),recheckAuthorization:at=>recheckFinanceAuthorization(ctx,tx,at,p.checks,denied())}),snapshot=guestDepositCashAdmissionSnapshot.parse({schemaVersion:1,operation:"ADMIT_CASH",commandHash:hash,input,source,policy:p.policy,liabilityAccountId:p.liability.id,unallocatedAccountId:p.unallocated.ledgerAccountId,cashSource:{id:p.cash.id,transactionId:p.cash.transactionId,custodyAccountId:p.cash.custodyAccountId,taskId:p.cash.taskId,taskType:p.taskType,recordedAt:p.cash.recordedAt.toISOString(),amount:p.cash.amount.toFixed(2),currency:p.cash.currency,collectorUserAccountId:p.cash.collectorUserAccountId,collectorPersonId:p.cash.collectorPersonId,provenance:p.cash.provenance}});
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.guest_deposit.received",resourceType:"financial_transaction",resourceId:row.id,after:json(snapshot),reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await p.finance.clock()});await repository.flushGuards();
  await recheckFinanceAuthorization(ctx,tx,await p.finance.clock(),p.checks,denied());const current=await repository.cashRemaining(p.cash.id,p.unallocated.ledgerAccountId,p.cash.currency);if(!Money.of(current.amount,p.cash.currency).equals(p.available.subtract(p.amount))||commandFingerprint(await resolveGuestDepositPolicyInTransaction(tx,ctx.organizationId,p.booking.propertyId,await p.finance.clock(),p.booking.id))!==commandFingerprint(p.policy))throw new GuestDepositConflictError();await p.periods.assertPostingOpen(p.now);await readGuestDepositSourceInTransaction(ctx,input.idempotencyKey,tx);return{id:row.id,depositId:input.idempotencyKey,operation:"ADMIT_CASH"as const,idempotent:false};
 });
}

// The shared recovery path validates the original actor, root and current grants.
export {recoverGuestDepositCommand as recoverGuestDepositCashAdmission};
