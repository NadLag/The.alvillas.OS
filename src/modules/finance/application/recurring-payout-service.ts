import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {recurringPayoutPolicyKey,recurringPayoutPolicySchema,RecurringPayoutPolicyError} from "../domain/recurring-payout";
import {ownerPayoutResource} from "../domain/owner-payout";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {OwnerPayoutRepository} from "../infrastructure/owner-payout-repository";
import {RecurringPayoutRepository} from "../infrastructure/recurring-payout-repository";
import {recheckFinanceAuthorization} from "./finance-access";
import {scheduleOwnerPayout} from "./owner-payout-payment-service";
import {OwnerPayoutAccessError,OwnerPayoutConflictError} from "./owner-payout-service";
type Deps={db?:TenantTransactionRunner;requestId?:string};

/** Durable scheduling of approved sources; existing approval and actual-payment requirements are preserved. */
export async function scheduleRecurringPayouts(organizationId:string,deps:Deps={}){
 return withTenant(deps.db??prisma,organizationId,async tx=>{
  const rules=new ConfigRuleRepository(tx,organizationId),repository=new RecurringPayoutRepository(tx,organizationId),payouts=new OwnerPayoutRepository(tx,organizationId),finance=new FinanceRepository(tx,organizationId);
  await rules.lockVersion(recurringPayoutPolicyKey,"organization",null);await repository.lock();
  const now=await finance.clock(),rule=await rules.resolve({key:recurringPayoutPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});if(!rule)return{configured:false,scheduled:0,pending:false};
  const parsed=recurringPayoutPolicySchema.safeParse(rule.value);if(!parsed.success||!rule.createdBy)throw new RecurringPayoutPolicyError();
  const ctx={organizationId,actorId:rule.createdBy,authContext:await authContextForAccountInTransaction(tx,organizationId,rule.createdBy)},authority=[
   {action:"configure"as const,resource:{type:"config_rule",organizationId,id:recurringPayoutPolicyKey},organizationOnly:true},
   ...["view","edit"].map(action=>({action:action as"view"|"edit",resource:{type:"financial_transaction",organizationId,dataClass:"financial"as const},organizationOnly:true}))
  ];await recheckFinanceAuthorization(ctx,tx,now,authority,new OwnerPayoutAccessError());
  const sources=await repository.eligible(now,parsed.data.batch_size),scheduled:string[]=[];
  for(const source of sources){
   if(!source.eligibleAt)throw new RecurringPayoutPolicyError();
   const command={id:source.id,expectedVersion:source.version,scheduledFor:source.eligibleAt.toISOString(),reason:rule.reason},result=await scheduleOwnerPayout(ctx,command,{db:repository.runner(),requestId:deps.requestId});
   if(result.idempotent)throw new OwnerPayoutConflictError();const row=await payouts.find(source.id);if(!row||row.state!=="SCHEDULED"||row.transactionId)throw new OwnerPayoutConflictError();
   await writeAuditEvent(tx,{organizationId,actorId:ctx.actorId,action:"finance.owner_payout.recurring_scheduled",resourceType:"owner_payout",resourceId:row.id,propertyScopeId:row.propertyId,
    after:{configRuleId:rule.id,sourceVersion:source.version,scheduledVersion:row.version,scheduledFor:command.scheduledFor},reason:rule.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});scheduled.push(row.id);
  }
  for(const id of scheduled){const row=await payouts.find(id);if(!row)throw new OwnerPayoutConflictError();const resource=ownerPayoutResource(organizationId,row,row.property);await recheckFinanceAuthorization(ctx,tx,await finance.clock(),[{action:"view",resource},{action:"edit",resource}],new OwnerPayoutAccessError());}
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),authority,new OwnerPayoutAccessError());
  return{configured:true,scheduled:scheduled.length,pending:(await repository.eligible(now,1)).length>0};
 });
}
export async function tickRecurringPayouts(organizationId:string,deps:Deps={}){
 try{return{...await scheduleRecurringPayouts(organizationId,deps),blocked:null};}catch(error){
  if(error instanceof OwnerPayoutAccessError)return{configured:true,scheduled:0,pending:true,blocked:"authority_unavailable"as const};
  if(error instanceof RecurringPayoutPolicyError)return{configured:true,scheduled:0,pending:true,blocked:"configuration_unavailable"as const};
  if(error instanceof OwnerPayoutConflictError)return{configured:true,scheduled:0,pending:true,blocked:"source_changed"as const};throw error;
 }
}
