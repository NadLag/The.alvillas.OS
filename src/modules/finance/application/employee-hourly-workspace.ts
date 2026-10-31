import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { encryptSecret,decryptSecret } from "@/platform/auth/secret-encryption";
import { present,catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { employeeHourlyRunPolicyKey,employeeHourlyRunPolicySchema } from "../domain/employee-hourly-run";
import { employeeCompensationRunWindow,EmployeeCompensationRunAccessError,EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { employeeHourlyPickerInput,employeeHourlyWorkSchema,employeeHourlyReviewInput,employeeHourlyReviewSchema } from "../domain/employee-hourly-workspace";
import { employeeHourlySourceEvidence } from "../domain/employee-hourly-evidence";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { EmployeeCompensationPickerRepository } from "../infrastructure/employee-compensation-picker-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeHourlyRunSourceRepository } from "../infrastructure/employee-hourly-run-source-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeCompensationSourceLabels } from "./employee-compensation-source-labels";
import { prepareEmployeeHourlyRunSources,prepareEmployeeHourlyRunCandidates } from "./employee-hourly-run-source";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
export { getEmployeeHourlyRunEditor } from "./employee-compensation-picker";
type Deps={db?:TenantTransactionRunner;requestId?:string};
type Source=Awaited<ReturnType<typeof prepareEmployeeHourlyRunSources>>;
const cursorSchema=employeeHourlyPickerInput.omit({after:true}).extend({kind:z.literal("hourly-work-picker-v1"),organizationId:z.uuid(),actorId:z.uuid(),policyRuleId:z.uuid(),id:z.uuid(),at:z.iso.datetime()}).strict();
const root=(organizationId:string,amount="0.00")=>({type:"employee_payable",organizationId,dataClass:"financial" as const,amount});
const rootChecks=(organizationId:string)=>[{action:"view" as const,resource:root(organizationId)},{action:"create" as const,resource:root(organizationId)}];
async function policyFor(ctx:FinanceActorContext,tx:TenantTransaction){const rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:employeeHourlyRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:await new FinanceRepository(tx,ctx.organizationId).clock()});if(!rule||rule.scopeType!=="organization"||rule.scopeId!==null)throw new EmployeeCompensationRunPolicyError();return{rule,policy:employeeHourlyRunPolicySchema.parse(rule.parsedValue)};}
function financialView<T extends Record<string,unknown>>(ctx:FinanceActorContext,data:T,amount="0.00"){return present({...ctx.authContext,visibleDataClasses:new Set()},"view",{...root(ctx.organizationId,amount),data},catalogFieldPolicy<T>("employee_payable"));}
async function display(ctx:FinanceActorContext,tx:TenantTransaction,lines:Source["lines"]){
 const picker=new EmployeeCompensationPickerRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),rows=await picker.display(lines.map(line=>({key:line.taskId+":"+line.assignmentId,taskId:line.taskId,personId:line.personId,propertyId:line.propertyId,compensationId:line.compensationId,completionEvent:line.sourceSnapshot.completionEvent}))),validators=await runs.people(lines.flatMap(line=>{const evidence=employeeCompletedWorkEvidence(line.sourceSnapshot.completionEvent);return evidence.validated_by_person_id?[evidence.validated_by_person_id]:[];})),metadata=await employeeCompensationSourceLabels(ctx,tx,rows,validators),labels=new Map(metadata.labels.map(row=>[row.lineId,row])),evidence=new Map((await new EmployeeHourlyRunSourceRepository(tx,ctx.organizationId).evidence(lines.map(line=>line.evidenceId))).map(row=>[row.id,row]));
 return{checks:metadata.checks,items:lines.map(line=>{
  const actual=evidence.get(line.evidenceId),label=labels.get(line.taskId+":"+line.assignmentId);if(!actual?.decision||actual.decision.id!==line.decisionId||!label)throw new EmployeeCompensationRunAccessError();
  const{lineId,...human}=label;void lineId;
  const hourlyCoverage=employeeHourlySourceEvidence({personId:line.personId,currency:line.amount.currency,amount:line.amount.amount,recordedCompletionAt:line.recordedCompletionAt,workTimeEvidence:actual,workTimeDecision:actual.decision,hourlyWitnesses:line.witnesses.map(witness=>({...witness,compensation:{version:witness.compensationVersion,amount:witness.rate.amount,currency:witness.rate.currency}}))});
  return{...human,earningKind:"PER_HOUR" as const,taskId:line.taskId,recordedCompletionAt:line.recordedCompletionAt.toISOString(),assignmentId:line.assignmentId,compensationId:line.compensationId,evidenceId:line.evidenceId,decisionId:line.decisionId,rate:line.rate,amount:line.amount,hourlyCoverage};
 })};
}

/** Bounded actual work discovery keeps each independently eligible contract explicit. */
export async function listEmployeeHourlyWork(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=employeeHourlyPickerInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const finance=new FinanceRepository(tx,ctx.organizationId);await recheckFinanceAuthorization(ctx,tx,await finance.clock(),rootChecks(ctx.organizationId),new EmployeeCompensationRunAccessError());
  const{rule,policy}=await policyFor(ctx,tx),window=employeeCompensationRunWindow(input.fromOn,input.toOn,{earning_date:policy.earning_date,timezone:policy.timezone,max_period_days:policy.max_period_days});let after:{at:string;id:string}|undefined;
  if(input.after)try{const cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.policyRuleId!==rule.id||cursor.fromOn!==input.fromOn||cursor.toOn!==input.toOn||cursor.currency!==input.currency||cursor.search!==input.search)throw new EmployeeCompensationRunAccessError();after={at:cursor.at,id:cursor.id};}catch{throw new EmployeeCompensationRunAccessError();}
  const picker=new EmployeeCompensationPickerRepository(tx,ctx.organizationId),page=await picker.hourlyWork({...window,after}),scanned=page.slice(0,25),pairs=await picker.hourlyAssignments(scanned,input.currency),work=new Map(scanned.map(row=>[row.id,row])),source=pairs.length?await prepareEmployeeHourlyRunCandidates(ctx,{fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,jobs:pairs.map(pair=>({taskId:pair.taskId,assignmentId:pair.assignmentId,evidenceId:work.get(pair.taskId)!.evidenceId,decisionId:work.get(pair.taskId)!.decisionId,confirmedAssignment:true}))},tx):null,metadata=await display(ctx,tx,source?.lines??[]),needle=input.search.toLocaleLowerCase("und"),visible=metadata.items.filter(row=>!needle||[row.personName,row.propertyName,row.roleName,...row.sourceTitle?Object.values(row.sourceTitle):[]].some(label=>label?.toLocaleLowerCase("und").includes(needle)));
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.hourly_work_listed",resourceType:"employee_compensation_run",resourceId:null,after:{taskIds:[...new Set(visible.map(row=>row.taskId))]},reason:"Selected independently authorized actual hourly work and canonical contracts",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
  await source?.recheck();if((await policyFor(ctx,tx)).rule.id!==rule.id)throw new EmployeeCompensationRunPolicyError();await recheckFinanceAuthorization(ctx,tx,await finance.clock(),[...rootChecks(ctx.organizationId),...metadata.checks],new EmployeeCompensationRunAccessError());
  return employeeHourlyWorkSchema.parse(financialView(ctx,{timezone:policy.timezone,items:scanned.flatMap(row=>{const choices=visible.filter(item=>item.taskId===row.id).map(item=>{const{taskId,recordedCompletionAt,...choice}=item;void taskId;void recordedCompletionAt;return choice;});return choices.length?[{taskId:row.id,recordedCompletionAt:new Date(row.at).toISOString(),choices}]:[];}),next:page.length>25?encryptSecret(JSON.stringify({kind:"hourly-work-picker-v1",organizationId:ctx.organizationId,actorId:ctx.actorId,policyRuleId:rule.id,fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,search:input.search,id:scanned.at(-1)!.id,at:scanned.at(-1)!.at})):null}));
 },{timeout:120000});
}

export async function reviewEmployeeHourlyRun(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=employeeHourlyReviewInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const finance=new FinanceRepository(tx,ctx.organizationId),source=await prepareEmployeeHourlyRunSources(ctx,{fromOn:input.fromOn,toOn:input.toOn,currency:input.currency,jobs:input.jobs},tx);
  if(input.after&&!source.lines.some(line=>line.taskId===input.after))throw new EmployeeCompensationRunAccessError();const remaining=source.lines.filter(line=>!input.after||line.taskId>input.after),selected=remaining.slice(0,50),metadata=await display(ctx,tx,selected);
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.hourly_run_reviewed",resourceType:"employee_compensation_run",resourceId:null,after:{taskIds:selected.map(line=>line.taskId)},reason:"Reviewed complete actual hourly earnings and every original effective rate",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});await source.recheck();await recheckFinanceAuthorization(ctx,tx,await finance.clock(),metadata.checks,new EmployeeCompensationRunAccessError());
  return employeeHourlyReviewSchema.parse(financialView(ctx,{reviewFingerprint:source.sourceFingerprint,fromOn:source.fromOn,toOn:source.toOn,currency:source.currency,timezone:source.window.policy.timezone,total:source.amount,lineCount:source.lines.length,policy:source.policy.value,lines:metadata.items,next:remaining.length>50?selected.at(-1)!.taskId:null},source.amount.amount));
 },{timeout:120000});
}
