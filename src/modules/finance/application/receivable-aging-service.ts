import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {encryptSecret,decryptSecret} from "@/platform/auth/secret-encryption";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {calendarDateAt} from "@/i18n/format";
import {ReceivableRepository} from "../infrastructure/receivable-repository";
import {ReceivableAgingRepository} from "../infrastructure/receivable-aging-repository";
import {receivablePolicyKey,ReceivableAccessError,ReceivablePolicyError} from "../domain/receivable";
import {receivableAgingPolicyKey,receivableAgingPolicySchema,receivableAgingInput,receivableAgingPageSchema,receivableAgingAmounts,receivableAgingBucket,receivableAgingTotals,receivableDaysPastDue,ReceivableAgingSourceError,ReceivableAgingChangedError} from "../domain/receivable-aging";
import {receivableAgingCompleteSource} from "../domain/receivable-aging";
import {receivableExportPolicyKey,receivableExportPolicySchema} from "../domain/receivable-export-policy";
import {receivableReminderPolicyKey,receivableReminderPolicySchema,receivableReminderRoutingKey} from "../domain/receivable-reminder-policy";
import {notificationRoutingSchema} from "@/platform/notifications/notification-routing";
import {recheckReceivableAuthority} from "./receivable-access";
import type {FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type ReminderAdmission={policyId:string;routingRuleId:string;reason:string;prepare:(source:unknown,tx:TenantTransaction)=>Promise<{occurrences:number;notificationsRequested:number}>};
type Intent={kind:"VIEW"}|{kind:"EXPORT";policyId:string;reason:string;prepare:(source:unknown)=>void}|({kind:"REMINDER"}&ReminderAdmission);
const cursorSchema=z.object({purpose:z.literal("receivable.aging.v1"),organizationId:z.uuid(),actorId:z.uuid(),filter:z.string().regex(/^[a-f0-9]{64}$/u),policy:z.string().regex(/^[a-f0-9]{64}$/u),snapshot:z.string().regex(/^[a-f0-9]{64}$/u),on:z.iso.date(),after:z.object({id:z.uuid(),dueOn:z.iso.date().nullable()}).strict()}).strict();
async function context(ctx:FinanceActorContext,tx:TenantTransaction,action:"view"|"export"|"configure"="view"){
 const now=await recheckReceivableAuthority(ctx,tx,action),configs=new ConfigRuleRepository(tx,ctx.organizationId),repository=new ReceivableRepository(tx,ctx.organizationId),scopes=[{scopeType:"organization",scopeId:null}];
 const[sourceRule,agingRule,settings,exportRule,reminderRule,routingRule]=await Promise.all([configs.resolve({key:receivablePolicyKey,scopes,asOf:now}),configs.resolve({key:receivableAgingPolicyKey,scopes,asOf:now}),repository.settings(),action==="export"?configs.resolve({key:receivableExportPolicyKey,scopes,asOf:now}):Promise.resolve(null),action==="configure"?configs.resolve({key:receivableReminderPolicyKey,scopes,asOf:now}):Promise.resolve(null),action==="configure"?configs.resolve({key:receivableReminderRoutingKey,scopes,asOf:now}):Promise.resolve(null)]);
 if(!sourceRule||!agingRule||!settings.timezone)throw new ReceivablePolicyError();
 const parsed=receivableAgingPolicySchema.safeParse(agingRule.value);if(!parsed.success)throw new ReceivablePolicyError();
 try{new Intl.DateTimeFormat("en",{timeZone:settings.timezone});requireCurrentTimezoneData();}catch{throw new ReceivablePolicyError();}
 const source=await repository.assertConfiguredAccounts(sourceRule.value);
 if(action==="export"&&(!exportRule||!receivableExportPolicySchema.safeParse(exportRule.value).success))throw new ReceivablePolicyError();
 if(action==="configure"&&(!reminderRule||!routingRule||!receivableReminderPolicySchema.safeParse(reminderRule.value).success||!notificationRoutingSchema.safeParse(routingRule.value).success))throw new ReceivablePolicyError();
 return{now,policy:parsed.data,source,agingRule,exportRule,reminderRule,routingRule,timezone:settings.timezone,currencies:settings.currencies.map(row=>row.code),identity:commandFingerprint({sourceRuleId:sourceRule.id,agingRuleId:agingRule.id,timezone:settings.timezone,...exportRule?{exportRuleId:exportRule.id}:{},...reminderRule?{reminderRuleId:reminderRule.id,routingRuleId:routingRule?.id}:{}})};
}
/** Current civil-date aging keeps unspecified terms separate and derives every cent from original movements. */
export async function getReceivableAging(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 return readReceivableAging(ctx,raw,deps,{kind:"VIEW"});
}
export async function getReceivableAgingForExport(ctx:FinanceActorContext,raw:unknown,admission:{policyId:string;reason:string;prepare:(source:unknown)=>void},deps:Deps={}){
 return readReceivableAging(ctx,raw,deps,{kind:"EXPORT",...admission});
}
export async function getReceivableAgingForReminders(ctx:FinanceActorContext,raw:unknown,admission:ReminderAdmission,deps:Deps={}){
 return readReceivableAging(ctx,raw,deps,{kind:"REMINDER",...admission});
}
async function readReceivableAging(ctx:FinanceActorContext,raw:unknown,deps:Deps,intent:Intent){
 const exporting=intent.kind==="EXPORT",complete=intent.kind!=="VIEW",action=exporting?"export":intent.kind==="REMINDER"?"configure":"view";
 const input=receivableAgingInput.parse(raw),filter=commandFingerprint({currency:input.currency,bucket:input.bucket??null,partyKind:input.partyKind??null,partyId:input.partyId??null,search:input.search});
 if(complete&&input.after)throw new ReceivableAgingChangedError();
 return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const source=await context(ctx,tx,action);if(!source.currencies.includes(input.currency))throw new ReceivableAgingSourceError();
  if(intent.kind==="EXPORT"&&source.exportRule?.id!==intent.policyId)throw new ReceivableAgingChangedError();
  if(intent.kind==="REMINDER"&&(source.reminderRule?.id!==intent.policyId||source.routingRule?.id!==intent.routingRuleId))throw new ReceivableAgingChangedError();
  if(input.bucket&&!["UNSCHEDULED","NOT_DUE",...source.policy.bands.map(band=>band.key)].includes(input.bucket))throw new ReceivableAgingChangedError();
  let cursor:z.infer<typeof cursorSchema>|undefined;
  if(input.after){try{cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.filter!==filter)throw new ReceivableAccessError();}catch{throw new ReceivableAccessError();}
   if(cursor.policy!==source.identity)throw new ReceivableAgingChangedError();}
  const report=await new ReceivableAgingRepository(tx,ctx.organizationId).snapshot({...input,timezone:source.timezone,policy:source.policy,accountCodes:source.source.account_codes,after:cursor?.after,all:complete});
  if(!report.valid||calendarDateAt(report.at,source.timezone)!==report.on)throw new ReceivableAgingSourceError();if(cursor&&(cursor.snapshot!==report.fingerprint||cursor.on!==report.on))throw new ReceivableAgingChangedError();
  const totals=receivableAgingTotals(source.policy,input.currency,report.groups),page=complete?report.items:report.items.slice(0,50),items=page.map(row=>{
   const amounts=receivableAgingAmounts(row.assigned,row.collected,input.currency),bucket=receivableAgingBucket(source.policy,report.on,row.dueOn);
   if(bucket!==row.bucket||amounts.outstanding.amount!==row.outstanding||row.daysPastDue!==(row.dueOn===null?null:receivableDaysPastDue(report.on,row.dueOn)))throw new ReceivableAgingSourceError();
   return{id:row.id,postingId:row.postingId,party:{kind:row.partyKind,id:row.partyId},purpose:row.purpose,dueOn:row.dueOn,daysPastDue:row.daysPastDue,bucket,...amounts};
  }),last=page.at(-1),next=!complete&&report.items.length>50&&last?encryptSecret(JSON.stringify({purpose:"receivable.aging.v1",organizationId:ctx.organizationId,actorId:ctx.actorId,filter,policy:source.identity,snapshot:report.fingerprint,on:report.on,after:{id:last.id,dueOn:last.dueOn}})):null,
   data={at:report.at.toISOString(),on:report.on,timezone:source.timezone,currency:input.currency,rule:{id:source.agingRule.id,version:source.agingRule.version},...totals,items,next},
   parsed=complete?{source:receivableAgingCompleteSource(data).source}:receivableAgingPageSchema.parse({source:data}),
   result=present({...ctx.authContext,visibleDataClasses:new Set()},action,{type:"receivable",organizationId:ctx.organizationId,id:ctx.organizationId,dataClass:"financial",data:parsed},catalogFieldPolicy<typeof parsed>("receivable"),report.at) as typeof parsed;
  if(intent.kind==="EXPORT")intent.prepare(result.source);
  const reminders=intent.kind==="REMINDER"?await intent.prepare(result.source,tx):null;
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:exporting?"finance.receivables.export_generated":intent.kind==="REMINDER"?"finance.receivables.reminders_generated":"finance.receivables.aging_viewed",resourceType:"receivable",resourceId:ctx.organizationId,after:{currency:input.currency,on:report.on,count:items.length,snapshot:report.fingerprint,policyId:source.agingRule.id,...source.exportRule?{exportPolicyId:source.exportRule.id}:{},...intent.kind==="REMINDER"?{reminderPolicyId:intent.policyId,reminderRoutingId:intent.routingRuleId,...reminders}:{}},reason:intent.kind!=="VIEW"?intent.reason:"Viewed current receivable aging from original assignments and posted movements",requestId:deps.requestId??crypto.randomUUID(),occurredAt:report.at});
  if((await context(ctx,tx,action)).identity!==source.identity)throw new ReceivableAgingChangedError();return result;
 });
}
