import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {createConfigRuleVersion} from "@/platform/config/rule-version-writer";
import {nextCivilRecurrenceDate} from "@/platform/time/configured-recurrence";
import {companyExpensePolicyKey,companyExpensePolicySchema,recurringCompanyExpensePolicyKey,recurringCompanyExpensePolicySchema,CompanyExpenseAccessError,CompanyExpenseChangedError} from "../domain/company-expense";
import {companyExpenseSettingsCommandSchema,companyExpenseSettingsSchema} from "../domain/company-expense-settings";
import {CompanyExpenseRepository} from "../infrastructure/company-expense-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {recheckCompanyExpenseDraftCreation} from "./company-expense-service";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
type Deps={db?:TenantTransactionRunner;requestId?:string};
async function authority(ctx:FinanceActorContext,tx:TenantTransaction){
 const now=await new FinanceRepository(tx,ctx.organizationId).clock();await recheckFinanceAuthorization(ctx,tx,now,[
  ...["company_expense","financial_transaction","staff_compensation"].map(type=>({action:"view"as const,resource:{type,organizationId:ctx.organizationId,dataClass:"financial"as const},organizationOnly:true})),
  {action:"create",resource:{type:"company_expense",organizationId:ctx.organizationId,dataClass:"financial"},organizationOnly:true},
  ...[companyExpensePolicyKey,recurringCompanyExpensePolicyKey].map(id=>({action:"configure"as const,resource:{type:"config_rule",organizationId:ctx.organizationId,id},organizationOnly:true}))
 ],new CompanyExpenseAccessError());return now;
}
async function read(ctx:FinanceActorContext,tx:TenantTransaction){
 const now=await authority(ctx,tx),rules=new ConfigRuleRepository(tx,ctx.organizationId),resolve=(key:string)=>rules.resolve({key,scopes:[{scopeType:"organization"as const,scopeId:null}],asOf:now});
 const policy=await resolve(companyExpensePolicyKey),recurrence=await resolve(recurringCompanyExpensePolicyKey),value=recurrence?recurringCompanyExpensePolicySchema.parse(recurrence.value):null;
 const result=companyExpenseSettingsSchema.parse({policyId:policy?.id??null,policy:policy?companyExpensePolicySchema.parse(policy.value):null,recurringPolicyId:recurrence?.id??null,batchSize:value?.batch_size??null,schedules:value?.expenses??[]});await authority(ctx,tx);return result;
}
export async function getCompanyExpenseSettings(ctx:FinanceActorContext,deps:Deps={}){return withTenant(deps.db??prisma,ctx.organizationId,tx=>read(ctx,tx));}
export async function canConfigureCompanyExpenseSettings(ctx:FinanceActorContext,tx:TenantTransaction){try{await authority(ctx,tx);return true;}catch(error){if(error instanceof CompanyExpenseAccessError)return false;throw error;}}
export async function saveCompanyExpenseSettings(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseSettingsCommandSchema.parse(raw),requestId=deps.requestId??randomUUID();return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  await authority(ctx,tx);const rules=new ConfigRuleRepository(tx,ctx.organizationId),repository=new CompanyExpenseRepository(tx,ctx.organizationId);
  // Match the native scheduler: recurring rule before the taxonomy used by native plan creation.
  await rules.lockVersion(recurringCompanyExpensePolicyKey,"organization",null);await rules.lockVersion(companyExpensePolicyKey,"organization",null);
  const current=await read(ctx,tx),recurring=input.operation==="SCHEDULE"||input.operation==="REMOVE_SCHEDULE",actual=recurring?current.recurringPolicyId:current.policyId;
  if(actual!==input.expectedPolicyId)throw new CompanyExpenseChangedError();
  let key:string,value:unknown;
  if(input.operation==="INITIALIZE"){
   if(current.policyId!==null)throw new CompanyExpenseChangedError();value=input.policy;key=companyExpensePolicyKey;
  }else if(input.operation==="CATEGORY"||input.operation==="COST_CENTER"){
   const categories=current.policy?.categories??[],centers=current.policy?.cost_centers??[];
   // Initialization supplies both required taxonomies together; edits retain every other identity.
   if(!categories.length||!centers.length)throw new CompanyExpenseChangedError();
   value=companyExpensePolicySchema.parse({categories:input.operation==="CATEGORY"?[...categories.filter(row=>row.key!==input.category.key),input.category]:categories,cost_centers:input.operation==="COST_CENTER"?[...centers.filter(row=>row.key!==input.costCenter.key),input.costCenter]:centers});key=companyExpensePolicyKey;
  }else{
   const id=input.operation==="SCHEDULE"?input.schedule.id:input.scheduleId;if(input.operation==="REMOVE_SCHEDULE"&&!current.schedules.some(row=>row.id===id))throw new CompanyExpenseChangedError();
   const policy=recurringCompanyExpensePolicySchema.parse({source:"COMPANY_EXPENSE_PLAN",principal:"CURRENT_CONFIGURATION_AUTHOR",batch_size:input.batchSize,expenses:[...current.schedules.filter(row=>row.id!==id),...input.operation==="SCHEDULE"?[input.schedule]:[]]});
   for(const item of policy.expenses){const on=nextCivilRecurrenceDate(item,null)??item.start_on;await recheckCompanyExpenseDraftCreation(ctx,tx,{...item.draft,dueOn:on,idempotencyKey:randomUUID(),reason:input.reason},randomUUID());}
   value=policy;key=recurringCompanyExpensePolicyKey;
  }
  const now=await new FinanceRepository(tx,ctx.organizationId).clock();await createConfigRuleVersion({...ctx,personId:ctx.authContext.personId??ctx.actorId},{key,scopeType:"organization",lifecycle:"ACTIVE",valueJson:JSON.stringify(value),effectiveFrom:now,reason:input.reason},{db:repository.runner(),requestId});await authority(ctx,tx);return read(ctx,tx);
 });
}
