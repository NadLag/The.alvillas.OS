import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { encryptSecret,decryptSecret } from "@/platform/auth/secret-encryption";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { calendarDateAt } from "@/i18n/format";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { employeeCompensationRunPolicyKey,employeeCompensationRunPolicySchema,employeeCompensationRunWindow,EmployeeCompensationRunAccessError,EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { EmployeeCompensationAccessError,EmployeeCompensationSourceUnavailableError } from "../domain/employee-compensation";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationPickerRepository } from "../infrastructure/employee-compensation-picker-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { validateEmployeeCompensationAssignment,validateEmployeeCompletedWorkSource,validateEmployeeCompensationRate } from "./employee-compensation-source";
import { employeeCompensationSourceLabels } from "./employee-compensation-source-labels";
import { employeeCompensationEditorSchema,employeeCompensationWorkSchema } from "../domain/employee-compensation-picker";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
import { employeeHourlyRunPolicyKey,employeeHourlyRunPolicySchema } from "../domain/employee-hourly-run";

type Deps={db?:TenantTransactionRunner;requestId?:string};
const filters=z.object({fromOn:z.iso.date(),toOn:z.iso.date(),currency:z.string().regex(/^[A-Z]{3}$/u)});
export const employeeCompensationPickerInput=filters.extend({after:z.string().min(1).max(4096).optional()}).strict();
const cursorSchema=filters.extend({kind:z.literal("compensation-work-picker-v1"),organizationId:z.uuid(),actorId:z.uuid(),id:z.uuid(),at:z.iso.datetime()}).strict();
const rootResource=(organizationId:string,at:Date,amount="0.00"):Resource=>({type:"employee_payable",organizationId,dataClass:"financial",amount,occurredAt:at});

/** Policy and currency choices contain no employee rate or earned amount. */
export async function getEmployeeCompensationRunEditor(ctx:FinanceActorContext,deps:Deps={}){
  return getEmployeeWorkRunEditor(ctx,"PER_JOB",deps);
}
export async function getEmployeeHourlyRunEditor(ctx:FinanceActorContext,deps:Deps={}){
  return getEmployeeWorkRunEditor(ctx,"PER_HOUR",deps);
}
async function getEmployeeWorkRunEditor(ctx:FinanceActorContext,mode:"PER_JOB"|"PER_HOUR",deps:Deps){
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const finance=new FinanceRepository(tx,ctx.organizationId),now=await finance.clock(),resource=rootResource(ctx.organizationId,now),checks=[{action:"view" as const,resource},{action:"create" as const,resource}];
    await recheckFinanceAuthorization(ctx,tx,now,checks,new EmployeeCompensationRunAccessError());
    const config=new ConfigRuleRepository(tx,ctx.organizationId),key=mode==="PER_HOUR"?employeeHourlyRunPolicyKey:employeeCompensationRunPolicyKey,rule=await config.resolve({key,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
    if(!rule||rule.scopeType!=="organization"||rule.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
    const policy=(mode==="PER_HOUR"?employeeHourlyRunPolicySchema:employeeCompensationRunPolicySchema).parse(rule.parsedValue),choices=await new EmployeeCompensationPickerRepository(tx,ctx.organizationId).editor();
    const current=await config.resolve({key,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
    if(JSON.stringify(rule)!==JSON.stringify(current))throw new EmployeeCompensationRunPolicyError();
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
    return employeeCompensationEditorSchema.parse({...choices,date:calendarDateAt(now,policy.timezone),timezone:policy.timezone,maxPeriodDays:policy.max_period_days});
  });
}

/** Every choice is genuine completed work with its eligible, explicitly selectable canonical contracts. */
export async function listEmployeeCompensationWork(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationPickerInput.parse(raw);let after:{at:string;id:string}|undefined;
  if(input.after){try{
    const cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));
    if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.fromOn!==input.fromOn||cursor.toOn!==input.toOn||cursor.currency!==input.currency)throw new EmployeeCompensationRunAccessError();
    after={at:cursor.at,id:cursor.id};
  }catch{throw new EmployeeCompensationRunAccessError();}}
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const finance=new FinanceRepository(tx,ctx.organizationId),now=await finance.clock(),root=rootResource(ctx.organizationId,now),rootChecks=[{action:"view" as const,resource:root},{action:"create" as const,resource:root}];
    await recheckFinanceAuthorization(ctx,tx,now,rootChecks,new EmployeeCompensationRunAccessError());
    const config=new ConfigRuleRepository(tx,ctx.organizationId),rule=await config.resolve({key:employeeCompensationRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
    if(!rule||rule.scopeType!=="organization"||rule.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
    const window=employeeCompensationRunWindow(input.fromOn,input.toOn,rule.parsedValue),picker=new EmployeeCompensationPickerRepository(tx,ctx.organizationId);
    requireCurrentTimezoneData();
    const databaseWindow=await new EmployeeCompensationRunRepository(tx,ctx.organizationId).window(input.fromOn,input.toOn,window.policy.timezone);
    if(databaseWindow.startsAt.getTime()!==window.startsAt.getTime()||databaseWindow.endsAt.getTime()!==window.endsAt.getTime())throw new EmployeeCompensationRunPolicyError();
    const page=await picker.work({...window,after}),scanned=page.slice(0,25),sources=new EmployeeCompensationRepository(tx,ctx.organizationId);
    const tasks=(await sources.completedWorks(scanned.map(row=>row.id))).sort((a,b)=>a.id.localeCompare(b.id)),taskMap=new Map(tasks.map(row=>[row.id,row]));
    const assignments=await picker.assignments(tasks.flatMap(task=>task.completedByPersonId?[task.completedByPersonId]:[]),window.startsAt,window.endsAt);
    const entries=tasks.flatMap(task=>task.completedAt&&task.completedByPersonId?assignments.filter(assignment=>assignment.personId===task.completedByPersonId).map(assignment=>({key:task.id+":"+assignment.id,taskId:task.id,assignmentId:assignment.id,earnedAt:task.completedAt!})):[]);
    const contracts=await sources.sources(entries),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    const checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[...rootChecks];
    const eligible=entries.flatMap(entry=>{
      const task=taskMap.get(entry.taskId)!,source=contracts.get(entry.key),rate=source?.rate;
      if(!source||!rate||rate.currency!==input.currency)return[];
      const salary:Resource={type:"staff_compensation",organizationId:ctx.organizationId,id:source.assignment.personId,assignedPersonId:source.assignment.personId,
        propertyId:task.propertyId,city:task.property.cityId,region:task.property.regionId,jobId:task.id,occurredAt:task.completedAt,dataClass:"financial",amount:rate.amount.toFixed(2)};
      const artifact=rootResource(ctx.organizationId,now,salary.amount as string),required=[{action:"view" as const,resource:salary},{action:"view" as const,resource:artifact},{action:"create" as const,resource:artifact}];
      if(!required.every(check=>[ctx.authContext,current].every(auth=>authorize(auth,check.action,check.resource,now))))return[];
      try{validateEmployeeCompensationAssignment(source,entry.earnedAt);validateEmployeeCompletedWorkSource(task,source);}catch(error){if(error instanceof EmployeeCompensationAccessError||error instanceof EmployeeCompensationSourceUnavailableError)return[];throw error;}
      checks.push(...required);return[{...entry,task,source,rate}];
    });
    // Private effective-dated rate rules are resolved only for already authorized real salary sources.
    const groups=new Map(eligible.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}]));
    const rules=eligible.length?await config.resolveDatedScopeGroups("staff.compensation",groups):new Map<string,Awaited<ReturnType<ConfigRuleRepository["resolve"]>>>();
    const verified=eligible.filter(entry=>{try{validateEmployeeCompensationRate(entry.source,rules.get(entry.key)??null);return true;}catch(error){if(error instanceof EmployeeCompensationSourceUnavailableError)return false;throw error;}});
    const display=await picker.display(verified.map(entry=>({key:entry.key,taskId:entry.taskId,personId:entry.source.assignment.personId,propertyId:entry.task.propertyId,compensationId:entry.rate.id,completionEvent:entry.task.events[0]})));
    const validatorIds=verified.flatMap(entry=>entry.task.validatedByPersonId?[entry.task.validatedByPersonId]:[]),validators=await new EmployeeCompensationRunRepository(tx,ctx.organizationId).people(validatorIds);
    const metadata=await employeeCompensationSourceLabels(ctx,tx,display,validators),labels=new Map(metadata.labels.map(row=>[row.lineId,row]));checks.push(...metadata.checks);
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation_work.listed",resourceType:"employee_compensation_run",resourceId:null,
      after:{taskIds:[...new Set(verified.map(entry=>entry.taskId))]},reason:"Selected authorized actual completed work contracts",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    const refreshed=(await sources.completedWorks(scanned.map(row=>row.id))).sort((a,b)=>a.id.localeCompare(b.id)),refreshedContracts=await sources.sources(entries),refreshedRules=eligible.length?await config.resolveDatedScopeGroups("staff.compensation",groups):new Map<string,Awaited<ReturnType<ConfigRuleRepository["resolve"]>>>();
    const latestPolicy=await config.resolve({key:employeeCompensationRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await finance.clock()});
    if(JSON.stringify(refreshed)!==JSON.stringify(tasks)||JSON.stringify([...refreshedContracts])!==JSON.stringify([...contracts])||JSON.stringify([...refreshedRules])!==JSON.stringify([...rules]))throw new EmployeeCompensationRunAccessError();
    if(JSON.stringify(latestPolicy)!==JSON.stringify(rule))throw new EmployeeCompensationRunPolicyError();
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
    return employeeCompensationWorkSchema.parse({timezone:window.policy.timezone,items:scanned.flatMap(row=>{
      const matches=verified.filter(entry=>entry.taskId===row.id);if(!matches.length)return[];
      return[{taskId:row.id,recordedCompletionAt:matches[0].earnedAt.toISOString(),choices:matches.map(entry=>{
        const label=labels.get(entry.key)!;
        return{assignmentId:entry.assignmentId,compensationId:entry.rate.id,rate:Money.of(entry.rate.amount.toString(),entry.rate.currency).toJSON(),
          personName:label.personName,propertyName:label.propertyName,roleName:label.roleName,contractVersion:label.contractVersion,effectiveFrom:label.effectiveFrom,
          sourceTitle:label.sourceTitle,canViewTask:label.canViewTask,completionMethod:label.completionMethod,validatorName:label.validatorName,validatedAt:label.validatedAt};
      })}];
    }),next:page.length>25?encryptSecret(JSON.stringify({kind:"compensation-work-picker-v1",organizationId:ctx.organizationId,actorId:ctx.actorId,fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,...scanned.at(-1)!})):null});
  },{timeout:120000});
}
