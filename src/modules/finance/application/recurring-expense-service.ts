import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {RecurringExpenseRepository} from "../infrastructure/recurring-expense-repository";
import {nextRecurringExpenseDate,recurringExpenseDue,recurringExpensePolicyKey,recurringExpensePolicySchema,RecurringExpenseAccessError,RecurringExpenseConfigurationError} from "../domain/recurring-expense";
import {createExpenseDraft,recheckExpenseDraftCreation,ExpenseAccessError,ExpenseConfigurationError} from "./expense-service";
import type {ExpenseDraftInput} from "../domain/expense";
import {recheckFinanceAuthorization} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
/** Creates original drafts only. Submission, invoices, approval, accounting periods and actual payment keep their existing gates. */
export async function scheduleRecurringExpenses(organizationId:string,deps:Deps={}){
 return withTenant(deps.db??prisma,organizationId,async tx=>{
  const repository=new RecurringExpenseRepository(tx,organizationId),rules=new ConfigRuleRepository(tx,organizationId),finance=new FinanceRepository(tx,organizationId);
  await rules.lockVersion(recurringExpensePolicyKey,"organization",null);await repository.lock();
  const now=await finance.clock(),rule=await rules.resolve({key:recurringExpensePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
  if(!rule)return{configured:false,created:0,pending:false};
  const parsed=recurringExpensePolicySchema.safeParse(rule.value);if(!parsed.success||!rule.createdBy)throw new RecurringExpenseConfigurationError();requireCurrentTimezoneData();
  const policy=parsed.data,ctx={organizationId,actorId:rule.createdBy,authContext:await authContextForAccountInTransaction(tx,organizationId,rule.createdBy)},
   authority=[{action:"configure" as const,resource:{type:"config_rule",organizationId,id:rule.id},organizationOnly:true}];
  await recheckFinanceAuthorization(ctx,tx,now,authority,new RecurringExpenseAccessError());
  const properties=new Map((await repository.properties(policy.expenses.map(item=>item.draft.propertyId))).map(row=>[row.id,row])),latest=await repository.latest(policy.expenses.map(item=>item.id));
  const due=policy.expenses.flatMap(schedule=>{const property=properties.get(schedule.draft.propertyId);if(!property)throw new RecurringExpenseConfigurationError();new Intl.DateTimeFormat("en",{timeZone:property.timezone});const on=nextRecurringExpenseDate(schedule,latest.get(schedule.id)??null);return on?[{schedule,on,timezone:property.timezone}]:[];});
  let created=0;const generated:Array<{input:ExpenseDraftInput;id:string}>=[];
  while(created<policy.batch_size){
   due.sort((a,b)=>a.on.localeCompare(b.on)||a.schedule.id.localeCompare(b.schedule.id));const index=due.findIndex(item=>recurringExpenseDue(item.on,item.schedule,now,item.timezone));if(index===-1)break;
   const item=due.splice(index,1)[0],input={...item.schedule.draft,occurredOn:item.on,emergency:false,idempotencyKey:randomUUID(),reason:rule.reason},draft=await createExpenseDraft(ctx,input,{db:repository.runner(),requestId:deps.requestId});generated.push({input,id:draft.id});
   const occurrence=await repository.record({scheduleId:item.schedule.id,on:item.on,configRuleId:rule.id,expenseId:draft.id,createdBy:ctx.actorId,createdAt:now});
   await writeAuditEvent(tx,{organizationId,actorId:ctx.actorId,action:"expense.recurring_generated",resourceType:"expense",resourceId:draft.id,propertyScopeId:item.schedule.draft.propertyId,
    after:{occurrenceId:occurrence.id,scheduleId:item.schedule.id,on:item.on,configRuleId:rule.id,timezone:item.timezone},reason:rule.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});
   created++;const next=nextRecurringExpenseDate(item.schedule,item.on);if(next)due.push({...item,on:next});
  }
  for(const item of generated)await recheckExpenseDraftCreation(ctx,tx,item.input,item.id);
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),authority,new RecurringExpenseAccessError());
  return{configured:true,created,pending:due.some(item=>recurringExpenseDue(item.on,item.schedule,now,item.timezone))};
 });
}

export async function tickRecurringExpenses(organizationId:string,deps:Deps={}){
 try{return{...await scheduleRecurringExpenses(organizationId,deps),blocked:null};}catch(error){
  if(error instanceof RecurringExpenseAccessError||error instanceof ExpenseAccessError)return{configured:true,created:0,pending:true,blocked:"authority_unavailable" as const};
  if(error instanceof RecurringExpenseConfigurationError||error instanceof ExpenseConfigurationError)return{configured:true,created:0,pending:true,blocked:"configuration_unavailable" as const};throw error;
 }
}
