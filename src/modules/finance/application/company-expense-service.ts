import {randomUUID} from "node:crypto";
import type {CompanyExpenseRevision,Prisma} from "@prisma/client";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {present} from "@/platform/authz/present";
import {Money} from "@/platform/money/money";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {CompanyExpenseRepository} from "../infrastructure/company-expense-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {ExpenseRepository} from "../infrastructure/expense-repository";
import {validateExpenseAmount,ExpenseConfigurationError} from "./expense-service";
import {companyExpensePolicyKey,companyExpensePolicySchema,companyExpenseDraftSchema,companyExpenseRevisionSchema,companyExpenseCancellationSchema,CompanyExpenseAccessError,CompanyExpenseConfigurationError,CompanyExpenseChangedError,type CompanyExpenseDraftInput} from "../domain/company-expense";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type CostFacts=Pick<CompanyExpenseRevision,"companyExpenseId"|"amount"|"currency"|"dataClass"|"state">;
export async function recheckCompanyExpenseAccess(ctx:FinanceActorContext,tx:TenantTransaction,row:CostFacts,action:"view"|"create"|"edit"|"void"){
 const now=await new FinanceRepository(tx,ctx.organizationId).clock(),base={organizationId:ctx.organizationId,dataClass:"financial"as const};
 await recheckFinanceAuthorization(ctx,tx,now,[
  {action,resource:{...base,type:"company_expense",id:row.companyExpenseId,financialRecordId:row.companyExpenseId,amount:row.amount.toFixed(2),status:row.state},organizationOnly:true},
  {action:"view",resource:{...base,type:"financial_transaction"},organizationOnly:true},
  ...row.dataClass==="STAFF_COMPENSATION"?[{action:"view"as const,resource:{...base,type:"staff_compensation"},organizationOnly:true}]:[]
 ],new CompanyExpenseAccessError());
}
function facts(row:CompanyExpenseRevision){return{revisionId:row.id,id:row.companyExpenseId,version:row.version,state:row.state,...Money.of(row.amount,row.currency).toJSON(),category:row.category,costCenter:row.costCenter,purpose:row.purpose,dueOn:row.dueOn.toISOString().slice(0,10),timezone:row.timezone,dataClass:row.dataClass,configRuleId:row.configRuleId,policySnapshot:row.policySnapshot};}
function same(row:CompanyExpenseRevision,input:CompanyExpenseDraftInput){return row.category===input.category&&row.costCenter===input.costCenter&&row.purpose===input.purpose&&row.dueOn.toISOString().slice(0,10)===input.dueOn&&Money.of(row.amount,row.currency).equals(Money.of(input.amount,input.currency))&&row.reason===input.reason;}
async function configured(ctx:FinanceActorContext,tx:TenantTransaction,input:Omit<CompanyExpenseDraftInput,"idempotencyKey">,previous?:CompanyExpenseRevision){
 const repository=new CompanyExpenseRepository(tx,ctx.organizationId),rules=new ConfigRuleRepository(tx,ctx.organizationId);await rules.lockVersion(companyExpensePolicyKey,"organization",null);
 const now=await new FinanceRepository(tx,ctx.organizationId).clock(),rule=await rules.resolve({key:companyExpensePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
 if(!rule)throw new CompanyExpenseConfigurationError();const parsed=companyExpensePolicySchema.safeParse(rule.value);if(!parsed.success)throw new CompanyExpenseConfigurationError();const policy=parsed.data,category=policy.categories.find(row=>row.key===input.category),costCenter=policy.cost_centers.find(row=>row.key===input.costCenter),calendar=await repository.configuredCalendar();
 if(!category||!costCenter||!calendar.timezone||!calendar.currencies.some(row=>row.code===input.currency))throw new CompanyExpenseConfigurationError();
 try{await validateExpenseAmount(new ExpenseRepository(tx,ctx.organizationId),input.amount,input.currency);}catch(error){if(error instanceof ExpenseConfigurationError)throw new CompanyExpenseConfigurationError();throw error;}
 requireCurrentTimezoneData();new Intl.DateTimeFormat("en",{timeZone:calendar.timezone});
 return{now,configRuleId:rule.id,policySnapshot:{category,costCenter},timezone:calendar.timezone,dataClass:previous?.dataClass==="STAFF_COMPENSATION"?previous.dataClass:category.data_class};
}
async function audit(ctx:FinanceActorContext,tx:TenantTransaction,row:CompanyExpenseRevision,deps:Deps,before?:CompanyExpenseRevision){await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:row.version===1?"company_expense.created":row.state==="CANCELLED"?"company_expense.cancelled":"company_expense.revised",resourceType:"company_expense",resourceId:row.companyExpenseId,...before?{before:facts(before)}:{},after:facts(row),reason:row.reason,requestId:deps.requestId??randomUUID(),occurredAt:row.createdAt});}
export async function createCompanyExpensePlan(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseDraftSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new CompanyExpenseRepository(tx,ctx.organizationId);await repository.lock("nonce:"+input.idempotencyKey);
  const original=await repository.byNonce(input.idempotencyKey);if(original){const first=original.revisions[0],latest=await repository.latest(original.id);if(!first||!latest||original.createdBy!==ctx.actorId||!same(first,input))throw new CompanyExpenseChangedError();await recheckCompanyExpenseAccess(ctx,tx,latest,"create");return{id:original.id,version:latest.version,idempotent:true};}
  const config=await configured(ctx,tx,input),id=randomUUID(),money=Money.of(input.amount,input.currency);
  await recheckCompanyExpenseAccess(ctx,tx,{companyExpenseId:id,amount:money.amount,currency:input.currency,dataClass:config.dataClass,state:"PLANNED"},"create");
  const plan=await repository.create({idempotencyKey:input.idempotencyKey,createdBy:ctx.actorId,createdAt:config.now});
  const row=await repository.append({companyExpenseId:plan.id,version:1,state:"PLANNED",amount:money.amount,currency:money.currency,category:input.category,costCenter:input.costCenter,purpose:input.purpose,dueOn:new Date(input.dueOn+"T00:00:00Z"),timezone:config.timezone,dataClass:config.dataClass,configRuleId:config.configRuleId,policySnapshot:config.policySnapshot,reason:input.reason,createdBy:ctx.actorId,createdAt:config.now});
  await audit(ctx,tx,row,deps);await recheckCompanyExpenseAccess(ctx,tx,row,"create");return{id:plan.id,version:1,idempotent:false};
 });
}
export async function reviseCompanyExpensePlan(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseRevisionSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new CompanyExpenseRepository(tx,ctx.organizationId);await repository.lock(input.id);const previous=await repository.latest(input.id);if(!previous)throw new CompanyExpenseAccessError();await recheckCompanyExpenseAccess(ctx,tx,previous,"edit");if(previous.version!==input.expectedVersion||previous.state!=="PLANNED")throw new CompanyExpenseChangedError();
  const config=await configured(ctx,tx,input,previous),money=Money.of(input.amount,input.currency),row=await repository.append({companyExpenseId:input.id,version:previous.version+1,state:"PLANNED",amount:money.amount,currency:money.currency,category:input.category,costCenter:input.costCenter,purpose:input.purpose,dueOn:new Date(input.dueOn+"T00:00:00Z"),timezone:config.timezone,dataClass:config.dataClass,configRuleId:config.configRuleId,policySnapshot:config.policySnapshot,reason:input.reason,createdBy:ctx.actorId,createdAt:config.now});
  await audit(ctx,tx,row,deps,previous);await recheckCompanyExpenseAccess(ctx,tx,row,"edit");return{id:input.id,version:row.version};
 });
}
export async function cancelCompanyExpensePlan(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseCancellationSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new CompanyExpenseRepository(tx,ctx.organizationId);await repository.lock(input.id);const previous=await repository.latest(input.id);if(!previous)throw new CompanyExpenseAccessError();await recheckCompanyExpenseAccess(ctx,tx,previous,"void");if(previous.version!==input.expectedVersion||previous.state!=="PLANNED")throw new CompanyExpenseChangedError();
  const {id:revisionId,...frozen}=previous;void revisionId;const row=await repository.append({...frozen,version:previous.version+1,state:"CANCELLED",policySnapshot:previous.policySnapshot as Prisma.InputJsonValue,reason:input.reason,createdBy:ctx.actorId,createdAt:await new FinanceRepository(tx,ctx.organizationId).clock()});
  await audit(ctx,tx,row,deps,previous);await recheckCompanyExpenseAccess(ctx,tx,row,"void");return{id:input.id,version:row.version};
 });
}
export async function getCompanyExpensePlan(ctx:FinanceActorContext,rawId:unknown,deps:Deps={}){
 const input=z.object({id:z.uuid(),beforeVersion:z.number().int().min(1).optional()}).strict().parse(typeof rawId==="string"?{id:rawId}:rawId),{id}=input;return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new CompanyExpenseRepository(tx,ctx.organizationId);await repository.lockPlanRead(id);const latest=await repository.latest(id);if(!latest)throw new CompanyExpenseAccessError();await recheckCompanyExpenseAccess(ctx,tx,latest,"view");const history=await repository.history(id,input.beforeVersion),rows=history.slice(0,50),render=(row:CompanyExpenseRevision)=>present({...ctx.authContext,visibleDataClasses:new Set(["financial"as const])},"view",{type:"company_expense",organizationId:ctx.organizationId,id,financialRecordId:id,dataClass:"financial",amount:row.amount.toFixed(2),data:{...facts(row),reason:row.reason,at:row.createdAt.toISOString()}},{amount:{dataClass:"financial"},purpose:{dataClass:"financial"},policySnapshot:{dataClass:"financial"}}),result=rows.map(render),current=render(latest);
  // Monotonic classification and unconditional organization grants protect the entire history page.
  await recheckCompanyExpenseAccess(ctx,tx,latest,"view");return{current,history:result,next:history.length>50?rows.at(-1)!.version:null};
 });
}
