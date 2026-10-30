import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import type { Action,Resource } from "@/platform/authz/authorize";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { lockWalletHolders } from "@/platform/ledger/wallet-lock";
import { Money } from "@/platform/money/money";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { ownerPayoutCommandSchema,ownerPayoutScheduleSchema,ownerPayoutPaymentSchema,ownerPayoutPostings,ownerPayoutResource,ownerPayoutFundingChecks } from "../domain/owner-payout";
import { isExpenseFundingAccount } from "../domain/expense";
import { OwnerPayoutRepository,type OwnerPayoutRecord } from "../infrastructure/owner-payout-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
import { ownerPayoutCapacity,ownerPayoutMethodHash } from "./owner-payout-policy";
import { OwnerPayoutAccessError,OwnerPayoutConflictError,OwnerPayoutConfigurationError } from "./owner-payout-service";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Command=z.infer<typeof ownerPayoutCommandSchema>;
type Check={action:Action;resource:Resource};
async function lockedPayout(ctx:FinanceActorContext,tx:TenantTransaction,id:string,lockFunding=false){
  const repository=new OwnerPayoutRepository(tx,ctx.organizationId),hint=await repository.find(id),finance=new FinanceRepository(tx,ctx.organizationId);
  if(!hint)throw new OwnerPayoutAccessError();
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),[{action:"view",resource:ownerPayoutResource(ctx.organizationId,hint,hint.property)}],new OwnerPayoutAccessError());
  const source=lockFunding?await finance.findLedgerAccountById(hint.fundingAccountId):null;
  if(source?.teamWallet)await lockWalletHolders(tx,ctx.organizationId,[source.teamWallet.personId]);
  await repository.lockOwner(hint.ownerId,hint.propertyId,hint.currency);await repository.lock(id);
  const row=await repository.find(id);
  if(!row||row.ownerId!==hint.ownerId||row.propertyId!==hint.propertyId||row.currency!==hint.currency||row.fundingAccountId!==hint.fundingAccountId)throw new OwnerPayoutConflictError();
  if(lockFunding){await new FinancialTransferRepository(tx,ctx.organizationId).lockAccounts([row.fundingAccountId]);await repository.lockMethod(row.payoutMethodId);}
  return{repository,row,finance,now:await finance.clock(),funding:lockFunding?await finance.findLedgerAccountById(row.fundingAccountId):null};
}
async function transitionAudit(ctx:FinanceActorContext,tx:TenantTransaction,row:OwnerPayoutRecord,command:Command,action:string,state:string,now:Date,deps:Deps,after:Record<string,unknown>={}){
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:`finance.owner_payout.${action}`,resourceType:"owner_payout",resourceId:row.id,propertyScopeId:row.propertyId,
    before:{state:row.state,version:row.version},after:{...after,payoutId:row.id,state,version:row.version+1},reason:command.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
}
async function sameAttempt(repository:OwnerPayoutRepository,row:OwnerPayoutRecord,ctx:FinanceActorContext,input:Command,action:string,fields:Record<string,unknown>={}){
  const audit=await repository.audit(row.id,`finance.owner_payout.${action}`),before=z.object({version:z.number()}).safeParse(audit?.before);
  const after=z.record(z.string(),z.unknown()).safeParse(audit?.after);
  if(!audit||audit.actorId!==ctx.actorId||audit.reason!==input.reason||!before.success||before.data.version!==input.expectedVersion||!after.success||
    Object.entries(fields).some(([key,value])=>after.data[key]!==value))throw new OwnerPayoutConflictError();
}

export async function scheduleOwnerPayout(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=ownerPayoutScheduleSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{repository,row,now}=await lockedPayout(ctx,tx,input.id),target=ownerPayoutResource(ctx.organizationId,row,row.property);
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource:target},{action:"edit",resource:target}],new OwnerPayoutAccessError());
    if(row.scheduledFor){await sameAttempt(repository,row,ctx,input,"scheduled",{scheduledFor:input.scheduledFor});return{id:row.id,version:row.version,state:row.state,idempotent:true};}
    const at=new Date(input.scheduledFor);
    if(row.state!=="APPROVED"||row.version!==input.expectedVersion||!row.eligibleAt||at<row.eligibleAt)throw new OwnerPayoutConflictError();
    if((await repository.transition(row.id,row.version,"APPROVED","SCHEDULED",ctx.actorId,{scheduledFor:at})).count!==1)throw new OwnerPayoutConflictError();
    await transitionAudit(ctx,tx,row,input,"scheduled","SCHEDULED",now,deps,{scheduledFor:at.toISOString()});
    await new OutboxRepository(tx,ctx.organizationId).append("PayoutScheduled",{payoutId:row.id,propertyId:row.propertyId,ownerId:row.ownerId,
      reservationId:row.reservationId,state:"SCHEDULED",version:row.version+1,scheduledFor:at.toISOString()},`payout:${row.id}:PayoutScheduled`,now);
    return{id:row.id,version:row.version+1,state:"SCHEDULED",idempotent:false};
  });
}

/** Records a completed manual transfer; it does not call an external bank. */
export async function payOwnerPayout(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=ownerPayoutPaymentSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{repository,row,finance,now,funding}=await lockedPayout(ctx,tx,input.id,true);
    if(!funding)throw new OwnerPayoutConfigurationError();
    const target=ownerPayoutResource(ctx.organizationId,row,row.property),checks:Check[]=[{action:"view",resource:target},{action:"pay",resource:target},
      {action:"create",resource:{...target,occurredAt:row.paidAt??now}},...ownerPayoutFundingChecks(ctx.organizationId,funding,row.amount.toString(),row.paidAt??now,"pay")];
    await recheckFinanceAuthorization(ctx,tx,now,checks,new OwnerPayoutAccessError());
    if(row.transactionId){await sameAttempt(repository,row,ctx,input,"paid",{paymentReference:input.paymentReference});return{id:row.id,version:row.version,state:row.state,transactionId:row.transactionId,idempotent:true};}
    if(row.state!=="SCHEDULED"||row.version!==input.expectedVersion||!row.scheduledFor||row.scheduledFor>now||!isExpenseFundingAccount(funding))throw new OwnerPayoutConflictError();
    const method=await repository.method(row.payoutMethodId);
    if(!method||method.status!=="ACTIVE"||method.archivedAt||ownerPayoutMethodHash(method)!==row.methodSnapshotHash)throw new OwnerPayoutConfigurationError("Approved recipient details changed");
    const frozen=z.object({payout:z.object({holdbackAmount:z.object({amount:z.string(),currency:z.literal(row.currency)})})}).parse(row.policySnapshot);
    const capacity=await ownerPayoutCapacity(ctx,row,tx,now),amount=Money.of(row.amount.toString(),row.currency);
    if(amount.amount.gt(capacity.balance.subtract(capacity.committed).subtract(Money.of(frozen.payout.holdbackAmount.amount,row.currency)).amount))throw new OwnerPayoutConflictError();
    const claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Owner payable",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
    const transaction=await finance.createFinancialTransaction({reference:`PAYOUT:${row.id}`,description:row.purpose,occurredAt:now,idempotencyKey:`payout:${row.id}:paid`,createdBy:ctx.actorId,
      postings:ownerPayoutPostings({payoutId:row.id,ownerId:row.ownerId,propertyId:row.propertyId,reservationId:row.reservationId??undefined,ownerPayableAccountId:claim.id,fundingAccountId:funding.id,amount}),
      recheckAuthorization:at=>recheckFinanceAuthorization(ctx,tx,at,checks,new OwnerPayoutAccessError())});
    if((await repository.transition(row.id,row.version,"SCHEDULED","PAID",ctx.actorId,{transactionId:transaction.id,paidAt:now,paymentReference:input.paymentReference})).count!==1)throw new OwnerPayoutConflictError();
    await transitionAudit(ctx,tx,row,input,"paid","PAID",now,deps,{transactionId:transaction.id,paymentReference:input.paymentReference,amount:amount.toJSON()});
    await new OutboxRepository(tx,ctx.organizationId).append("PayoutPaid",{payoutId:row.id,propertyId:row.propertyId,ownerId:row.ownerId,
      reservationId:row.reservationId,state:"PAID",version:row.version+1,transactionId:transaction.id,paidAt:now.toISOString()},`payout:${row.id}:PayoutPaid`,now);
    return{id:row.id,version:row.version+1,state:"PAID",transactionId:transaction.id,idempotent:false};
  });
}

export async function reverseOwnerPayout(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=ownerPayoutCommandSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{repository,row,finance,now,funding}=await lockedPayout(ctx,tx,input.id,true);
    if(!row.transaction||!funding)throw new OwnerPayoutConflictError();
    const original=row.transaction,target=ownerPayoutResource(ctx.organizationId,row,row.property),checks:Check[]=[{action:"view",resource:target},{action:"void",resource:target},
      {action:"void",resource:{...target,id:original.id,financialRecordId:original.id,occurredAt:original.occurredAt}},...ownerPayoutFundingChecks(ctx.organizationId,funding,row.amount.toString(),original.occurredAt,"void")];
    await recheckFinanceAuthorization(ctx,tx,now,checks,new OwnerPayoutAccessError());
    if(row.reversalTransactionId){await sameAttempt(repository,row,ctx,input,"reversed");return{id:row.id,version:row.version,reversalTransactionId:row.reversalTransactionId,idempotent:true};}
    if(row.state!=="PAID"||row.version!==input.expectedVersion||original.reversedByTransactions.length)throw new OwnerPayoutConflictError();
    const reversal=await finance.createFinancialTransaction({reference:`PAYOUT:${row.id}:VOID`,description:input.reason,occurredAt:now,idempotencyKey:`payout:${row.id}:reversed`,reversesTransactionId:original.id,createdBy:ctx.actorId,
      postings:original.postings.map(posting=>({ledgerAccountId:posting.ledgerAccountId,side:posting.side==="DEBIT"?"CREDIT" as const:"DEBIT" as const,
        amount:Money.of(posting.amount.toString(),posting.currency),bucket:z.string().parse(posting.bucket),dimensions:z.record(z.string(),z.unknown()).parse(posting.dimensions)})),
      recheckAuthorization:at=>recheckFinanceAuthorization(ctx,tx,at,checks,new OwnerPayoutAccessError())});
    if((await repository.transition(row.id,row.version,"PAID","CANCELLED",ctx.actorId,{reversalTransactionId:reversal.id})).count!==1)throw new OwnerPayoutConflictError();
    await transitionAudit(ctx,tx,row,input,"reversed","CANCELLED",now,deps,{transactionId:original.id,reversalTransactionId:reversal.id});
    return{id:row.id,version:row.version+1,reversalTransactionId:reversal.id,idempotent:false};
  });
}

export async function failOwnerPayout(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=ownerPayoutCommandSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{repository,row,now}=await lockedPayout(ctx,tx,input.id),target=ownerPayoutResource(ctx.organizationId,row,row.property);
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource:target},{action:"edit",resource:target}],new OwnerPayoutAccessError());
    if(row.state==="FAILED"){await sameAttempt(repository,row,ctx,input,"failed");return{id:row.id,version:row.version,idempotent:true};}
    if(row.state!=="SCHEDULED"||row.version!==input.expectedVersion||row.transactionId)throw new OwnerPayoutConflictError();
    if((await repository.transition(row.id,row.version,"SCHEDULED","FAILED",ctx.actorId,{failureReason:input.reason})).count!==1)throw new OwnerPayoutConflictError();
    await transitionAudit(ctx,tx,row,input,"failed","FAILED",now,deps,{failureReason:input.reason});
    return{id:row.id,version:row.version+1,idempotent:false};
  });
}

export async function cancelOwnerPayout(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=ownerPayoutCommandSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{repository,row,now}=await lockedPayout(ctx,tx,input.id),target=ownerPayoutResource(ctx.organizationId,row,row.property);
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource:target},{action:"void",resource:target}],new OwnerPayoutAccessError());
    if(row.state==="CANCELLED"&&!row.transactionId){await sameAttempt(repository,row,ctx,input,"cancelled");return{id:row.id,version:row.version,idempotent:true};}
    const from=z.enum(["DRAFT","PENDING_APPROVAL","APPROVED","SCHEDULED"]).safeParse(row.state);
    if(!from.success||row.version!==input.expectedVersion||row.transactionId)throw new OwnerPayoutConflictError();
    const approvals=new ApprovalRepository(tx,ctx.organizationId);
    for(const approval of row.approvals){
      // Completed reviewer decisions remain immutable evidence after cancellation.
      if(approval.state!=="PENDING")continue;
      await approvals.find(approval.id,true);
      for(const stage of approval.financialStages.filter(stage=>stage.state==="PENDING"))await approvals.decideStage(stage.id,"CANCELLED",ctx.actorId,input.reason,now);
      await approvals.decide(approval.id,"CANCELLED",ctx.actorId,input.reason,now);
      await approvals.resolveNotifications(approval.id,"CANCELLED",now);await approvals.event("ApprovalDecided",approval.id,row.propertyId);
      await new NotificationRepository(tx,ctx.organizationId).publish({kind:"approval_decided",recipientId:approval.requestedBy,targetId:approval.id},`approval:${approval.id}:decided`);
    }
    if((await repository.transition(row.id,row.version,from.data,"CANCELLED",ctx.actorId)).count!==1)throw new OwnerPayoutConflictError();
    await transitionAudit(ctx,tx,row,input,"cancelled","CANCELLED",now,deps);
    return{id:row.id,version:row.version+1,idempotent:false};
  });
}
