import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {createConfigRuleVersion} from "@/platform/config/rule-version-writer";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {ExpenseRepository} from "../infrastructure/expense-repository";
import {RecurringExpenseRepository} from "../infrastructure/recurring-expense-repository";
import {recurringExpensePolicyKey,recurringExpensePolicySchema,RecurringExpenseAccessError,nextRecurringExpenseDate} from "../domain/recurring-expense";
import {recurringExpenseSettingsCommandSchema,recurringExpenseSettingsSchema,RecurringExpenseChangedError} from "../domain/recurring-expense-settings";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
import {recheckExpenseDraftCreation} from "./expense-service";
type Deps={db?:TenantTransactionRunner;requestId?:string};
async function authority(ctx:FinanceActorContext,tx:TenantTransaction){
 if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new RecurringExpenseAccessError();
 const now=await new FinanceRepository(tx,ctx.organizationId).clock(),base={organizationId:ctx.organizationId,dataClass:"financial"as const};
 await recheckFinanceAuthorization(ctx,tx,now,[
  ...["expense","financial_transaction"].map(type=>({action:"view"as const,resource:{...base,type},organizationOnly:true})),
  {action:"create",resource:{...base,type:"expense"},organizationOnly:true},
  {action:"configure",resource:{type:"config_rule",id:recurringExpensePolicyKey,organizationId:ctx.organizationId},organizationOnly:true}
 ],new RecurringExpenseAccessError());return now;
}
async function read(ctx:FinanceActorContext,tx:TenantTransaction,propertyId:string,requestId:string){
 const now=await authority(ctx,tx),expenses=new ExpenseRepository(tx,ctx.organizationId),repository=new RecurringExpenseRepository(tx,ctx.organizationId),property=await expenses.property(propertyId);if(!property)throw new RecurringExpenseAccessError();
 const [rule,sources,history]=await Promise.all([new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:recurringExpensePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now}),expenses.editorSources(),repository.history(propertyId)]),policy=rule?recurringExpensePolicySchema.parse(rule.value):null;
 const result=recurringExpenseSettingsSchema.parse({property:{id:property.id,name:property.name,timezone:property.timezone},currencies:sources.currencies.map(item=>item.code),policyId:rule?.id??null,batchSize:policy?.batch_size??null,schedules:policy?.expenses.filter(item=>item.draft.propertyId===propertyId)??[],history:history.map(item=>({id:item.id,scheduleId:item.scheduleId,on:item.on.toISOString().slice(0,10),expenseId:item.expenseId,at:item.createdAt.toISOString()}))});
 await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"expense.recurring_settings_viewed",resourceType:"expense",resourceId:propertyId,propertyScopeId:propertyId,after:{policyId:rule?.id??null,count:result.schedules.length},reason:"Viewed authorized recurring property expense schedules",requestId,occurredAt:now});await authority(ctx,tx);return result;
}
export async function getRecurringExpenseSettings(ctx:FinanceActorContext,rawPropertyId:unknown,deps:Deps={}){const propertyId=z.uuid().parse(rawPropertyId).toLowerCase();return withTenant(deps.db??prisma,ctx.organizationId,tx=>read(ctx,tx,propertyId,deps.requestId??randomUUID()));}
export async function saveRecurringExpenseSettings(ctx:FinanceActorContext,rawPropertyId:unknown,raw:unknown,deps:Deps={}){
 const propertyId=z.uuid().parse(rawPropertyId).toLowerCase(),input=recurringExpenseSettingsCommandSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  await authority(ctx,tx);const rules=new ConfigRuleRepository(tx,ctx.organizationId),repository=new RecurringExpenseRepository(tx,ctx.organizationId);await rules.lockVersion(recurringExpensePolicyKey,"organization",null);await repository.lock();
  const now=await new FinanceRepository(tx,ctx.organizationId).clock(),current=await rules.resolve({key:recurringExpensePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});if((current?.id??null)!==input.expectedPolicyId)throw new RecurringExpenseChangedError();
  const policy=current?recurringExpensePolicySchema.parse(current.value):null,schedules=policy?.expenses??[],id=input.operation==="SAVE"?input.schedule.id:input.scheduleId,previous=schedules.find(item=>item.id===id);
  if(previous&&previous.draft.propertyId!==propertyId||input.operation==="REMOVE"&&!previous||input.operation==="SAVE"&&input.schedule.draft.propertyId!==propertyId)throw new RecurringExpenseAccessError();
  const value=recurringExpensePolicySchema.parse({source:"PROPERTY_EXPENSE_DRAFT",principal:"CURRENT_CONFIGURATION_AUTHOR",batch_size:input.batchSize,expenses:[...schedules.filter(item=>item.id!==id),...input.operation==="SAVE"?[input.schedule]:[]]});
  // A new author must actually be able to create every retained schedule; no implicit elevated job identity.
  for(const item of value.expenses){const on=nextRecurringExpenseDate(item,null);if(on)await recheckExpenseDraftCreation(ctx,tx,{...item.draft,occurredOn:on,emergency:false,idempotencyKey:randomUUID(),reason:input.reason},randomUUID());}
  const requestId=deps.requestId??randomUUID();await createConfigRuleVersion({...ctx,personId:ctx.authContext.personId??ctx.actorId},{key:recurringExpensePolicyKey,scopeType:"organization",lifecycle:"ACTIVE",valueJson:JSON.stringify(value),effectiveFrom:now,reason:input.reason},{db:repository.runner(),requestId});await authority(ctx,tx);return read(ctx,tx,propertyId,requestId);
 });
}
