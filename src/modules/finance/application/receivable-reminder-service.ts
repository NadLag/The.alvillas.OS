import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {NotificationRepository} from "@/platform/notifications/notification-repository";
import {publishNotifications} from "@/platform/notifications/notification-service";
import {notificationRoutingSchema} from "@/platform/notifications/notification-routing";
import {calendarDateAt} from "@/i18n/format";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {ReceivableRepository} from "../infrastructure/receivable-repository";
import {ReceivableReminderRepository} from "../infrastructure/receivable-reminder-repository";
import {receivablePolicyKey,ReceivablePolicyError,ReceivableAccessError} from "../domain/receivable";
import {receivableAgingPolicyKey,receivableAgingCompleteSourceSchema,ReceivableAgingChangedError} from "../domain/receivable-aging";
import {receivableReminderPolicyKey,receivableReminderPolicySchema,receivableReminderRoutingKey} from "../domain/receivable-reminder-policy";
import {receivableReminderOccurrence} from "../domain/receivable-reminder";
import {getReceivableAgingForReminders} from "./receivable-aging-service";
import {recheckReceivableAuthority} from "./receivable-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
class ReminderWindowDeferred extends Error{}
const result=(configured:boolean)=>({configured,currencies:0,occurrences:0,notificationsRequested:0});
function localTime(at:Date,timezone:string){return new Intl.DateTimeFormat("en-GB",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(at);}

/** The existing signed background dispatcher polls; every business occurrence is configured and durable. */
export async function scheduleReceivableReminders(organizationId:string,deps:Deps={}){
 try{return await withTenant(deps.db??prisma,organizationId,async tx=>{
  const rules=new ConfigRuleRepository(tx,organizationId),finance=new FinanceRepository(tx,organizationId),repository=new ReceivableReminderRepository(tx,organizationId),scopes=[{scopeType:"organization",scopeId:null}];
  for(const key of[receivablePolicyKey,receivableAgingPolicyKey,receivableReminderPolicyKey,receivableReminderRoutingKey].sort())await rules.lockVersion(key,"organization",null);
  const now=await finance.clock(),rule=await rules.resolve({key:receivableReminderPolicyKey,scopes,asOf:now});if(!rule)return result(false);
  const routingRule=await rules.resolve({key:receivableReminderRoutingKey,scopes,asOf:now}),policy=receivableReminderPolicySchema.safeParse(rule.value),routing=notificationRoutingSchema.safeParse(routingRule?.value);
  if(!rule.createdBy||!routingRule||!policy.success||!routing.success||routing.data.assigned)throw new ReceivablePolicyError();
  const ctx={organizationId,actorId:rule.createdBy,authContext:await authContextForAccountInTransaction(tx,organizationId,rule.createdBy)};
  await recheckReceivableAuthority(ctx,tx,"configure");
  const accounts=new ReceivableRepository(tx,organizationId),settings=await accounts.settings();if(!settings.timezone)throw new ReceivablePolicyError();
  try{new Intl.DateTimeFormat("en",{timeZone:settings.timezone});requireCurrentTimezoneData();}catch{throw new ReceivablePolicyError();}
  const on=calendarDateAt(now,settings.timezone),totals=result(true);
  if(localTime(now,settings.timezone)<policy.data.send_at||!routing.data.channels.length||!routing.data.people.length&&!routing.data.roles.length)return totals;
  const recipients=await new NotificationRepository(tx,organizationId).receivableReminderRecipients(routing.data);if(!recipients.length)return totals;
  const sourceRule=await rules.resolve({key:receivablePolicyKey,scopes,asOf:now});if(!sourceRule)throw new ReceivablePolicyError();const source=await accounts.assertConfiguredAccounts(sourceRule.value);
  for(const currency of await repository.currencies(source.account_codes)){
   if(await repository.completed({policyId:rule.id,routingRuleId:routingRule.id,on,currency}))continue;
   let prepared={occurrences:0,notificationsRequested:0};
   await getReceivableAgingForReminders(ctx,{currency},{policyId:rule.id,routingRuleId:routingRule.id,reason:rule.reason,prepare:async raw=>{
    const report=receivableAgingCompleteSourceSchema.parse(raw),at=new Date(report.at),time=localTime(at,report.timezone);if(time<policy.data.send_at)throw new ReminderWindowDeferred();
    const entries:Parameters<NotificationRepository["publishMany"]>[0]=[];let occurrences=0;
    for(const item of report.items){
     const occurrence=receivableReminderOccurrence(policy.data,{assignmentId:item.id,policyId:rule.id,on:report.on,localTime:time,dueOn:item.dueOn,outstanding:item.outstanding});if(!occurrence)continue;occurrences++;
     for(const recipientId of recipients){const eventId=randomUUID();entries.push({eventId,occurredAt:at,key:occurrence.idempotencyKey+":"+recipientId,input:{kind:"receivable_reminder",recipientId,targetId:eventId,receivableNotice:{assignmentId:item.id,policyId:rule.id,routingRuleId:routingRule.id,on:report.on,occurrenceOn:occurrence.on,stage:occurrence.stage,currency,routing:routing.data}}});}
    }
    await publishNotifications(tx,organizationId,entries);prepared={occurrences,notificationsRequested:entries.length};return prepared;
   }},{db:repository.runner(),requestId:deps.requestId});
   totals.currencies++;totals.occurrences+=prepared.occurrences;totals.notificationsRequested+=prepared.notificationsRequested;
  }
  await recheckReceivableAuthority(ctx,tx,"configure");return totals;
 });}catch(error){if(error instanceof ReminderWindowDeferred)return result(true);throw error;}
}

/** An unavailable principal or changed policy must not stop other tenants' dispatcher work. */
export async function tickReceivableReminders(organizationId:string,deps:Deps={}){
 try{return{...await scheduleReceivableReminders(organizationId,deps),blocked:null};}catch(error){if(error instanceof ReceivableAccessError)return{...result(true),blocked:"authority_unavailable" as const};if(error instanceof ReceivablePolicyError)return{...result(true),blocked:"configuration_unavailable" as const};if(error instanceof ReceivableAgingChangedError)return{...result(true),blocked:"source_changed" as const};throw error;}
}
