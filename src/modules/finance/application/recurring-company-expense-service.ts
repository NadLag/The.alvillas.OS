import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {nextCivilRecurrenceDate,civilRecurrenceDue} from "@/platform/time/configured-recurrence";
import {CompanyExpenseRepository} from "../infrastructure/company-expense-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {recurringCompanyExpensePolicyKey,recurringCompanyExpensePolicySchema,CompanyExpenseAccessError,CompanyExpenseConfigurationError} from "../domain/company-expense";
import {createCompanyExpensePlan,recheckCompanyExpenseAccess} from "./company-expense-service";
import {recheckFinanceAuthorization} from "./finance-access";
type Deps={db?:TenantTransactionRunner;requestId?:string};
export async function scheduleRecurringCompanyExpenses(organizationId:string,deps:Deps={}){
 return withTenant(deps.db??prisma,organizationId,async tx=>{
  const rules=new ConfigRuleRepository(tx,organizationId),repository=new CompanyExpenseRepository(tx,organizationId);await rules.lockVersion(recurringCompanyExpensePolicyKey,"organization",null);await repository.lock("recurring");
  const now=await new FinanceRepository(tx,organizationId).clock(),rule=await rules.resolve({key:recurringCompanyExpensePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});if(!rule)return{configured:false,created:0,pending:false};
  const parsed=recurringCompanyExpensePolicySchema.safeParse(rule.value);if(!parsed.success||!rule.createdBy)throw new CompanyExpenseConfigurationError();const policy=parsed.data,ctx={organizationId,actorId:rule.createdBy,authContext:await authContextForAccountInTransaction(tx,organizationId,rule.createdBy)},authority=[{action:"configure"as const,resource:{type:"config_rule",organizationId,id:rule.id},organizationOnly:true}];await recheckFinanceAuthorization(ctx,tx,now,authority,new CompanyExpenseAccessError());
  const calendar=await repository.configuredCalendar();if(!calendar.timezone)throw new CompanyExpenseConfigurationError();new Intl.DateTimeFormat("en",{timeZone:calendar.timezone});
  const latest=await repository.latestOccurrences(policy.expenses.map(row=>row.id)),queue=policy.expenses.flatMap(schedule=>{const on=nextCivilRecurrenceDate(schedule,latest.get(schedule.id)??null);return on?[{schedule,on}]:[];}),createdIds:string[]=[];
  while(createdIds.length<policy.batch_size){queue.sort((a,b)=>a.on.localeCompare(b.on)||a.schedule.id.localeCompare(b.schedule.id));const index=queue.findIndex(item=>civilRecurrenceDue(item.on,item.schedule,now,calendar.timezone!));if(index===-1)break;const item=queue.splice(index,1)[0],result=await createCompanyExpensePlan(ctx,{...item.schedule.draft,dueOn:item.on,idempotencyKey:randomUUID(),reason:rule.reason},{db:repository.runner(),requestId:deps.requestId});
   const occurrence=await repository.recordOccurrence({scheduleId:item.schedule.id,on:item.on,configRuleId:rule.id,companyExpenseId:result.id,createdBy:ctx.actorId,createdAt:now});await writeAuditEvent(tx,{organizationId,actorId:ctx.actorId,action:"company_expense.recurring_generated",resourceType:"company_expense",resourceId:result.id,after:{occurrenceId:occurrence.id,scheduleId:item.schedule.id,on:item.on,configRuleId:rule.id,timezone:calendar.timezone},reason:rule.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});createdIds.push(result.id);const next=nextCivilRecurrenceDate(item.schedule,item.on);if(next)queue.push({...item,on:next});
  }
  for(const id of createdIds){const row=await repository.latest(id);if(!row)throw new CompanyExpenseConfigurationError();await recheckCompanyExpenseAccess(ctx,tx,row,"create");}await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,organizationId).clock(),authority,new CompanyExpenseAccessError());return{configured:true,created:createdIds.length,pending:queue.some(item=>civilRecurrenceDue(item.on,item.schedule,now,calendar.timezone!))};
 });
}
export async function tickRecurringCompanyExpenses(organizationId:string,deps:Deps={}){try{return{...await scheduleRecurringCompanyExpenses(organizationId,deps),blocked:null};}catch(error){if(error instanceof CompanyExpenseAccessError)return{configured:true,created:0,pending:true,blocked:"authority_unavailable"as const};if(error instanceof CompanyExpenseConfigurationError)return{configured:true,created:0,pending:true,blocked:"configuration_unavailable"as const};throw error;}}
