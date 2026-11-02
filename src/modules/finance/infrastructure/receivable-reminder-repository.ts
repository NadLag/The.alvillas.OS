import {Prisma} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {calendarDateAt} from "@/i18n/format";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {Money} from "@/platform/money/money";
import {ReceivableRepository} from "./receivable-repository";
import {ReceivableAgingRepository} from "./receivable-aging-repository";
import {receivablePolicyKey,ReceivablePolicyError} from "../domain/receivable";
import {receivableAgingPolicyKey,receivableAgingPolicySchema,ReceivableAgingSourceError} from "../domain/receivable-aging";
import {receivableReminderPolicyKey,receivableReminderPolicySchema,receivableReminderRoutingKey} from "../domain/receivable-reminder-policy";
import {notificationRoutingSchema} from "@/platform/notifications/notification-routing";

export class ReceivableReminderRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 lastRun(){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,action:"finance.receivables.reminders_generated"},orderBy:[{occurredAt:"desc"},{id:"desc"}],select:{occurredAt:true,after:true}});}
 completed(input:{policyId:string;routingRuleId:string;on:string;currency:string}){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,action:"finance.receivables.reminders_generated",AND:[{after:{path:["reminderPolicyId"],equals:input.policyId}},{after:{path:["reminderRoutingId"],equals:input.routingRuleId}},{after:{path:["on"],equals:input.on}},{after:{path:["currency"],equals:input.currency}}]},select:{id:true}});}
 async currencies(accountCodes:readonly string[]){const rows=await this.tx.$queryRaw<Array<{currency:string}>>(Prisma.sql`SELECT DISTINCT a.currency FROM receivable_assignment a JOIN posting p ON p.organization_id=a.organization_id AND p.id=a.posting_id JOIN ledger_account account ON account.organization_id=p.organization_id AND account.id=p.ledger_account_id WHERE a.organization_id=${this.organizationId}::uuid AND a.due_on IS NOT NULL AND account.code IN (${Prisma.join(accountCodes)}) AND NOT EXISTS(SELECT 1 FROM receivable_assignment_release r WHERE r.organization_id=a.organization_id AND r.assignment_id=a.id) ORDER BY a.currency`);return rows.map(row=>row.currency);}
 /** Notification availability reuses the current canonical projection; it never derives a second balance. */
 async current(currencies:readonly string[],now:Date){
  const configs=new ConfigRuleRepository(this.tx,this.organizationId),repository=new ReceivableRepository(this.tx,this.organizationId),scopes=[{scopeType:"organization",scopeId:null}],
   [source,aging,policy,routing,settings]=await Promise.all([configs.resolve({key:receivablePolicyKey,scopes,asOf:now}),configs.resolve({key:receivableAgingPolicyKey,scopes,asOf:now}),configs.resolve({key:receivableReminderPolicyKey,scopes,asOf:now}),configs.resolve({key:receivableReminderRoutingKey,scopes,asOf:now}),repository.settings()]);
  if(!source||!aging||!policy||!routing||!settings.timezone)return null;const bands=receivableAgingPolicySchema.safeParse(aging.value),reminders=receivableReminderPolicySchema.safeParse(policy.value),audience=notificationRoutingSchema.safeParse(routing.value);if(!bands.success||!reminders.success||!audience.success)return null;
  try{new Intl.DateTimeFormat("en",{timeZone:settings.timezone});requireCurrentTimezoneData();}catch{return null;}
  let accounts:Awaited<ReturnType<ReceivableRepository["assertConfiguredAccounts"]>>;try{accounts=await repository.assertConfiguredAccounts(source.value);}catch(error){if(error instanceof ReceivablePolicyError)return null;throw error;}
  const items=new Map<string,{id:string;dueOn:string;currency:string;outstanding:{amount:string;currency:string}}>();
  for(const currency of new Set(currencies)){if(!settings.currencies.some(row=>row.code===currency))continue;const snapshot=await new ReceivableAgingRepository(this.tx,this.organizationId).snapshot({currency,search:"",timezone:settings.timezone,policy:bands.data,accountCodes:accounts.account_codes,all:true});if(!snapshot.valid||calendarDateAt(snapshot.at,settings.timezone)!==snapshot.on)throw new ReceivableAgingSourceError();for(const item of snapshot.items){const outstanding=Money.of(item.outstanding,currency);if(item.dueOn!==null&&outstanding.amount.gt(0))items.set(item.id,{id:item.id,dueOn:item.dueOn,currency,outstanding:outstanding.toJSON()});}}
  return{policy,reminders:reminders.data,routing,routingValue:audience.data,timezone:settings.timezone,items};
 }
}
