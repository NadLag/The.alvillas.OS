import { createHash } from "node:crypto";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { employeeMonthlyEarnedAmountForWindow,employeeMonthlyEarningsPolicyKey,employeeMonthlyEarningsWindow } from "../domain/employee-monthly-earnings";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { EmployeeCompensationAccessError,EmployeeCompensationBasisError,EmployeeCompensationSourceUnavailableError } from "../domain/employee-compensation";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeCompensationContractResource,validateEmployeeCompensationAssignment,validateEmployeeCompensationRate } from "./employee-compensation-source";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
import { employeeMonthlyRunSourceInput } from "../domain/employee-monthly-run-request";
export { employeeMonthlyRunSourceInput } from "../domain/employee-monthly-run-request";

/** Prepared evidence contains no current-clock value or authorization grant. */
export function employeeMonthlyRunSourceFingerprint(source:Awaited<ReturnType<typeof prepareEmployeeMonthlyRunSources>>){return source.sourceFingerprint;}

/** Prepare complete past calendar earnings from real assignment contracts, with no fabricated job or completion. */
export function prepareEmployeeMonthlyRunSources(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction,action:"create"|"edit"="create"){return prepareMonthlySources(ctx,raw,tx,action,false);}
/** Picker candidates use the same calendar, original rates and Money calculation, checked independently before selection. */
export function prepareEmployeeMonthlyRunCandidates(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction){return prepareMonthlySources(ctx,raw,tx,"create",true);}
async function prepareMonthlySources(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction,action:"create"|"edit",candidateSelection:boolean){
 const input=employeeMonthlyRunSourceInput.parse(raw),contracts=new EmployeeCompensationRepository(tx,ctx.organizationId),config=new ConfigRuleRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
 input.assignments.sort((a,b)=>a.assignmentId.localeCompare(b.assignmentId));requireCurrentTimezoneData();
 const build=async()=>{
  const now=await finance.clock(),policy=await config.resolve({key:employeeMonthlyEarningsPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});if(!policy||policy.scopeType!=="organization"||policy.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
  const window=employeeMonthlyEarningsWindow(input.month,policy.parsedValue);if(window.endsAt>now)throw new EmployeeCompensationRunPolicyError();
  // The final local calendar date is derived in calendar space, independently of its UTC offset.
  const last=new Date(window.toOn+"T00:00:00.000Z");last.setUTCDate(last.getUTCDate()+1);const endOn=last.toISOString().slice(0,10);
  const actualPoints=await runs.calendarPoints([...window.days.map(day=>day.on),endOn],window.policy.timezone),expected=[...window.days.map(day=>day.startsAt),window.endsAt];
  if(actualPoints.length!==expected.length||actualPoints.some((point,index)=>point.at.getTime()!==expected[index].getTime()))throw new EmployeeCompensationRunPolicyError();
  const allEntries=input.assignments.flatMap(row=>window.days.map(day=>({key:row.assignmentId+":"+day.on,assignmentId:row.assignmentId,earnedAt:day.startsAt}))),sources=await contracts.sources(allEntries);
  const byAssignment=new Map<string,typeof allEntries>();for(const entry of allEntries){const group=byAssignment.get(entry.assignmentId)??[];group.push(entry);byAssignment.set(entry.assignmentId,group);}
  const current=candidateSelection?await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId):null;
  const can=(resource:Resource)=>Boolean(current&&[ctx.authContext,current].every(auth=>authorize(auth,"view",resource,now)));
  const selected=candidateSelection?input.assignments.filter(row=>(byAssignment.get(row.assignmentId)??[]).every(entry=>{const source=sources.get(entry.key);return source&&(!source.rate||can(employeeCompensationContractResource(ctx.organizationId,source,entry.earnedAt)));})):input.assignments;
  const selectedIds=new Set(selected.map(row=>row.assignmentId)),entries=allEntries.filter(entry=>selectedIds.has(entry.assignmentId));
  const salaryChecks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[];
  for(const entry of entries){const source=sources.get(entry.key);if(!source?.rate)continue;salaryChecks.push({action:"view",resource:employeeCompensationContractResource(ctx.organizationId,source,entry.earnedAt)});}
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),salaryChecks,new EmployeeCompensationRunAccessError());
  const groups=new Map(entries.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}])),rules=await config.resolveDatedScopeGroups("staff.compensation",groups);
  const lines=selected.flatMap(row=>{try{
   for(const entry of (byAssignment.get(row.assignmentId)??[])){const source=sources.get(entry.key);if(source?.rate)validateEmployeeCompensationRate(source,rules.get(entry.key)??null);}
   const days=window.days.map(day=>{const source=sources.get(row.assignmentId+":"+day.on);if(!source)throw new EmployeeCompensationRunAccessError();const assignment=source.assignment,until=[assignment.validTo,assignment.archivedAt,assignment.person.archivedAt].filter((at):at is Date=>at!==null),eligible=assignment.validFrom<=day.startsAt&&until.every(at=>at>=day.endsAt)&&source.rate?.mode==="PER_MONTH";
    if(eligible)validateEmployeeCompensationAssignment(source,day.startsAt);return{on:day.on,eligible,rate:eligible?Money.of(source.rate!.amount.toString(),source.rate!.currency):null,source};});
   const earned=employeeMonthlyEarnedAmountForWindow(window,input.currency,days),first=days.find(day=>day.eligible)!,source=first.source,rate=source.rate!;
   if(candidateSelection){const root:Resource={type:"employee_payable",organizationId:ctx.organizationId,dataClass:"financial",amount:earned.amount.toJSON().amount,occurredAt:now};if(!current||![ctx.authContext,current].every(auth=>authorize(auth,"view",root,now)&&authorize(auth,"create",root,now))||(byAssignment.get(row.assignmentId)??[]).some(entry=>{const actual=sources.get(entry.key);return actual?.rate&&!can({...employeeCompensationContractResource(ctx.organizationId,actual,entry.earnedAt),amount:earned.amount.toJSON().amount});}))return[];}
   return[{assignmentId:row.assignmentId,personId:source.assignment.personId,propertyId:source.property?.id??null,sourceCityId:source.property?null:source.city?.id??null,sourceRegionId:source.property?null:source.region?.id??source.city?.regionId??null,taskId:source.assignment.scopeType==="job"?source.assignment.scopeId:null,compensationId:rate.id,configRuleId:rate.configRuleId,rate:Money.of(rate.amount.toString(),rate.currency).toJSON(),amount:earned.amount.toJSON(),eligibleDays:earned.eligibleDays,calendarDays:earned.calendarDays,
    sourceSnapshot:{schemaVersion:1,kind:"MONTHLY_CONTRACT_EARNINGS",month:input.month,assignmentId:row.assignmentId,personId:source.assignment.personId,policyRuleId:policy.id,policyVersion:policy.version,policy:policy.value,days:days.map(day=>({on:day.on,eligible:day.eligible,assignment:day.source.assignment,compensation:day.source.rate,rule:day.source.rate?rules.get(row.assignmentId+":"+day.on)??null:null})),amount:earned.amount.toJSON()}}];
  }catch(error){if(candidateSelection&&(error instanceof EmployeeCompensationAccessError||error instanceof EmployeeCompensationBasisError||error instanceof EmployeeCompensationSourceUnavailableError||error instanceof EmployeeCompensationRunAccessError))return[];throw error;}});
  const totals=new Map<string,Money>();let total=Money.zero(input.currency);for(const line of lines){const amount=Money.of(line.amount.amount,input.currency);total=total.add(amount);totals.set(line.personId,(totals.get(line.personId)??Money.zero(input.currency)).add(amount));}
  const root:Resource={type:"employee_payable",organizationId:ctx.organizationId,dataClass:"financial",amount:candidateSelection?"0.00":total.toJSON().amount,occurredAt:now},checks=[{action:"view" as const,resource:root},{action,resource:root},...salaryChecks];
  for(const line of lines){if(candidateSelection){const resource={...root,amount:line.amount.amount};checks.push({action:"view",resource},{action,resource});}for(const entry of (byAssignment.get(line.assignmentId)??[])){const source=sources.get(entry.key);if(source?.rate)checks.push({action:"view",resource:{...employeeCompensationContractResource(ctx.organizationId,source,entry.earnedAt),amount:candidateSelection?line.amount.amount:totals.get(source.assignment.personId)!.toJSON().amount}});}}
  await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
  return{policy:{id:policy.id,version:policy.version,value:policy.value},month:input.month,fromOn:window.fromOn,toOn:window.toOn,endsAt:window.endsAt,calendarPoints:window.days.map(day=>({on:day.on,startsAt:day.startsAt})),timezone:window.policy.timezone,currency:input.currency,amount:total.toJSON(),lines};
 };
 const captured=await build(),retained=JSON.stringify(captured);return{...captured,sourceFingerprint:createHash("sha256").update(retained).digest("hex"),recheck:async()=>{if(JSON.stringify(await build())!==retained)throw new EmployeeCompensationRunAccessError();}};
}
