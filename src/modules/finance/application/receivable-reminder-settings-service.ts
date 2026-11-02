import{z}from"zod";
import{prisma}from"@/platform/db/client";
import{withTenant,type TenantTransaction,type TenantTransactionRunner}from"@/platform/db/tenant";
import{authContextForAccountInTransaction}from"@/platform/authz/account-context";
import{authorizeOrganizationSource}from"@/platform/authz/organization-authority";
import{ConfigRuleRepository}from"@/platform/config/config-rule-repository";
import{writeAuditEvent}from"@/platform/audit/audit-writer";
import{notificationRoutingSchema}from"@/platform/notifications/notification-routing";
import{createConfigRuleVersion}from"@/modules/config/application/config-service";
import{FinanceRepository}from"../infrastructure/finance-repository";
import{ReceivableRepository}from"../infrastructure/receivable-repository";
import{ReceivableReminderRepository}from"../infrastructure/receivable-reminder-repository";
import{ReceivableAccessError}from"../domain/receivable";
import{ReceivableAgingChangedError}from"../domain/receivable-aging";
import{receivableReminderPolicyKey,receivableReminderRoutingKey}from"../domain/receivable-reminder-policy";
import{receivableReminderSettingsInput,receivableReminderSettingsSchema}from"../domain/receivable-reminder-settings";
import{recheckReceivableAuthority}from"./receivable-access";
import type{FinanceActorContext}from"./finance-access";
type Deps={db?:TenantTransactionRunner;requestId?:string};
async function canConfigure(ctx:FinanceActorContext,tx:TenantTransaction){const now=await recheckReceivableAuthority(ctx,tx),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);return[ctx.authContext,current].every(authority=>authorizeOrganizationSource(authority,"configure",{type:"receivable",organizationId:ctx.organizationId,dataClass:"financial"},now)&&authorizeOrganizationSource(authority,"configure",{type:"config_rule",id:receivableReminderPolicyKey,organizationId:ctx.organizationId},now));}
async function model(ctx:FinanceActorContext,tx:TenantTransaction,requestId:string){
 if(!await canConfigure(ctx,tx))return receivableReminderSettingsSchema.parse({source:{canConfigure:false}});
 const rules=new ConfigRuleRepository(tx,ctx.organizationId),now=await new FinanceRepository(tx,ctx.organizationId).clock(),scopes=[{scopeType:"organization",scopeId:null}],repository=new ReceivableReminderRepository(tx,ctx.organizationId),[rule,routing,settings,history]=await Promise.all([rules.resolve({key:receivableReminderPolicyKey,scopes,asOf:now}),rules.resolve({key:receivableReminderRoutingKey,scopes,asOf:now}),new ReceivableRepository(tx,ctx.organizationId).settings(),repository.lastRun()]);
 const audience=routing?notificationRoutingSchema.parse(routing.value):null,last=history?z.object({on:z.iso.date(),currency:z.string(),occurrences:z.number().int().nonnegative(),notificationsRequested:z.number().int().nonnegative()}).parse(history.after):null;
 const result=receivableReminderSettingsSchema.parse({source:{canConfigure:true,timezone:settings.timezone,policy:rule?{id:rule.id,version:rule.version,value:rule.value}:null,routing:{configured:Boolean(audience&&!audience.assigned&&audience.channels.length&&(audience.people.length||audience.roles.length)),people:audience?.people.length??0,roles:audience?.roles.length??0,channels:audience?.channels??[]},lastRun:history&&last?{at:history.occurredAt.toISOString(),...last}:null}});
 await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.reminder_settings_viewed",resourceType:"receivable",resourceId:ctx.organizationId,after:{policyId:rule?.id??null,routingRuleId:routing?.id??null},reason:"Viewed independently authorized company receivable reminder settings",requestId,occurredAt:now});
 if(!await canConfigure(ctx,tx))throw new ReceivableAccessError();return result;
}
export function getReceivableReminderSettings(ctx:FinanceActorContext,deps:Deps={}){return withTenant(deps.db??prisma,ctx.organizationId,tx=>model(ctx,tx,deps.requestId??crypto.randomUUID()));}
export async function saveReceivableReminderSettings(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=receivableReminderSettingsInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
 if(!await canConfigure(ctx,tx))throw new ReceivableAccessError();const rules=new ConfigRuleRepository(tx,ctx.organizationId);await rules.lockVersion(receivableReminderPolicyKey,"organization",null);const now=await new FinanceRepository(tx,ctx.organizationId).clock(),current=await rules.resolve({key:receivableReminderPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});if((current?.id??null)!==input.expectedPolicyId)throw new ReceivableAgingChangedError();
 const runner=new ReceivableReminderRepository(tx,ctx.organizationId).runner(),requestId=deps.requestId??crypto.randomUUID();await createConfigRuleVersion({...ctx,personId:ctx.authContext.personId??ctx.actorId},{key:receivableReminderPolicyKey,scopeType:"organization",lifecycle:"ACTIVE",valueJson:JSON.stringify(input.policy),effectiveFrom:now,reason:input.reason},{db:runner,requestId});if(!await canConfigure(ctx,tx))throw new ReceivableAccessError();return model(ctx,tx,requestId);
});}
