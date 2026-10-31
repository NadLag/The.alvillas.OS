import type { TenantTransaction } from "@/platform/db/tenant";
import { authorizeCollection } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeHourlyRunSourceRepository } from "../infrastructure/employee-hourly-run-source-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeHourlyRunSourceInput,employeeHourlyRunPolicyKey,employeeHourlyRunPolicySchema } from "../domain/employee-hourly-run";
import { employeeHourlyEarnedAmount,employeeHourlyEarningsPolicyKey,employeeHourlyEarningsPolicySchema } from "../domain/employee-hourly-earnings";
import { employeeCompensationRunWindow,EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { employeeCompensationContractResource,validateEmployeeCompensationAssignment,validateEmployeeCompensationRate,validateEmployeeCompletedWorkSource,validateEmployeeCompletedWorkEvidence } from "./employee-compensation-source";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import type { FinanceActorContext } from "./finance-access";

/** Prepare actual approved work and every original effective rate; no planned duration is an earning input. */
export async function prepareEmployeeHourlyRunSources(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction,action:"create"|"edit"="create"){
 const input=employeeHourlyRunSourceInput.parse(raw);input.jobs.sort((a,b)=>a.taskId.localeCompare(b.taskId));
 if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId||!authorizeCollection(ctx.authContext,"view","employee_payable")||!authorizeCollection(ctx.authContext,action,"employee_payable"))throw new EmployeeCompensationRunAccessError();
 const work=new EmployeeHourlyRunSourceRepository(tx,ctx.organizationId),contracts=new EmployeeCompensationRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),config=new ConfigRuleRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);requireCurrentTimezoneData();
 const build=async()=>{
  const currentAuthority=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
  if(!authorizeCollection(currentAuthority,"view","employee_payable")||!authorizeCollection(currentAuthority,action,"employee_payable"))throw new EmployeeCompensationRunAccessError();
  const now=await finance.clock(),policy=await config.resolve({key:employeeHourlyRunPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
  if(!policy||policy.scopeType!=="organization"||policy.scopeId!==null)throw new EmployeeCompensationRunPolicyError();
  const hourlyPolicy=employeeHourlyRunPolicySchema.parse(policy.parsedValue),window=employeeCompensationRunWindow(input.fromOn,input.toOn,{earning_date:hourlyPolicy.earning_date,timezone:hourlyPolicy.timezone,max_period_days:hourlyPolicy.max_period_days}),database=await runs.window(input.fromOn,input.toOn,window.policy.timezone);
  if(database.startsAt.getTime()!==window.startsAt.getTime()||database.endsAt.getTime()!==window.endsAt.getTime())throw new EmployeeCompensationRunPolicyError();
  const [evidence,tasks,latest]=await Promise.all([work.evidence(input.jobs.map(job=>job.evidenceId)),contracts.completedWorks(input.jobs.map(job=>job.taskId)),work.latest(input.jobs.map(job=>job.taskId))]);
  const byEvidence=new Map(evidence.map(row=>[row.id,row])),byTask=new Map(tasks.map(row=>[row.id,row])),current=new Map(latest.map(row=>[row.taskId,row]));
  const records=input.jobs.map(job=>{const row=byEvidence.get(job.evidenceId),task=byTask.get(job.taskId);if(!row||!task||row.taskId!==task.id||row.kind!=="ACTUAL_INTERVALS"||!row.decision||row.decision.id!==job.decisionId||row.decision.verdict!=="APPROVED"||current.get(task.id)?.id!==row.id||row.performedByPersonId!==task.completedByPersonId||!task.completedAt||task.completedAt>now||task.completedAt<window.startsAt||task.completedAt>=window.endsAt||!row.intervals.length)throw new EmployeeCompensationRunAccessError();
   const original=validateEmployeeCompletedWorkEvidence(task),rules=employeeHourlyEarningsPolicySchema.parse(row.policySnapshot);
   if(row.completionEventId!==original.event.id||commandFingerprint(row.sourceSnapshot)!==commandFingerprint(original.event.after)||row.policyRule.key!==employeeHourlyEarningsPolicyKey||row.policyRule.scopeType!=="organization"||row.policyRule.scopeId!==null||commandFingerprint(row.policySnapshot)!==commandFingerprint(row.policyRule.value))throw new EmployeeCompensationRunAccessError();
   return{job,row,task,original,rules};});
  if(hourlyPolicy.overlap_between_sources==="REJECT_PER_PERSON"){
   const byPerson=new Map<string,Array<{startsAt:Date;endsAt:Date}>>();for(const record of records){const existing=byPerson.get(record.row.performedByPersonId)??[];existing.push(...record.row.intervals);byPerson.set(record.row.performedByPersonId,existing);}
   for(const intervals of byPerson.values()){const ordered=[...intervals].sort((a,b)=>a.startsAt.getTime()-b.startsAt.getTime());for(let index=1;index<ordered.length;index++)if(ordered[index].startsAt<ordered[index-1].endsAt)throw new EmployeeCompensationRunPolicyError();}
  }
  const intervals=records.flatMap(record=>record.row.intervals),startsAt=new Date(intervals.reduce((first,item)=>Math.min(first,item.startsAt.getTime()),Infinity)),endsAt=new Date(intervals.reduce((last,item)=>Math.max(last,item.endsAt.getTime()),-Infinity)),boundaries=await work.rateBoundaries(input.jobs.map(job=>job.assignmentId),startsAt,endsAt);
  if(boundaries.some(row=>!row.precise))throw new EmployeeCompensationRunPolicyError();
  const segments=records.flatMap(record=>record.row.intervals.flatMap(interval=>{const points=[interval.startsAt,...boundaries.filter(point=>point.assignmentId===record.job.assignmentId&&point.effectiveFrom>interval.startsAt&&point.effectiveFrom<interval.endsAt).map(point=>point.effectiveFrom),interval.endsAt],ordered=[...new Map(points.map(point=>[point.getTime(),point])).values()].sort((a,b)=>a.getTime()-b.getTime());return ordered.slice(0,-1).map((point,index)=>({record,interval,startsAt:point,endsAt:ordered[index+1],key:record.task.id+":"+interval.id+":"+point.toISOString()}));}));
  const entries=segments.map(segment=>({key:segment.key,assignmentId:segment.record.job.assignmentId,earnedAt:segment.startsAt})),sources=await contracts.sources(entries),groups=new Map(entries.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}])),rates=await config.resolveDatedScopeGroups("staff.compensation",groups),salaryChecks:Array<NonNullable<Parameters<typeof recheckEmployeeCompensationRun>[5]>[number]>=[];
  const retained=segments.map(segment=>{const source=sources.get(segment.key);if(!source?.rate||source.rate.mode!=="PER_HOUR"||source.rate.currency!==input.currency)throw new EmployeeCompensationRunAccessError();
   validateEmployeeCompensationAssignment(source,segment.startsAt);validateEmployeeCompensationAssignment(source,new Date(segment.endsAt.getTime()-1));validateEmployeeCompletedWorkSource(segment.record.task,source,"PER_HOUR");const rule=validateEmployeeCompensationRate(source,rates.get(segment.key)??null);
   salaryChecks.push({action:"view",resource:employeeCompensationContractResource(ctx.organizationId,source,segment.startsAt,segment.record.task.id)});
   return{...segment,source,rule,rate:Money.of(source.rate.amount.toString(),input.currency)};});
  const lines=records.map(record=>{const portions=retained.filter(segment=>segment.record.task.id===record.task.id),first=portions[0];if(!first)throw new EmployeeCompensationRunAccessError();
   const amount=employeeHourlyEarnedAmount(record.rules,input.currency,record.task.completedAt!,record.row.intervals.map(interval=>({id:interval.id,startsAt:interval.startsAt,endsAt:interval.endsAt,performedByPersonId:record.row.performedByPersonId,validatedByPersonId:record.row.decision!.decidedByPersonId,slices:portions.filter(segment=>segment.interval.id===interval.id).map(segment=>({startsAt:segment.startsAt,endsAt:segment.endsAt,rate:segment.rate}))}))),witnesses=portions.map(segment=>({intervalId:segment.interval.id,compensationId:segment.source.rate!.id,configRuleId:segment.rule.id,startsAt:segment.startsAt,endsAt:segment.endsAt,rate:segment.rate.toJSON(),compensationVersion:segment.source.rate!.version,configVersion:segment.rule.version,assignment:segment.source.assignment,compensation:segment.source.rate!,contractRule:{id:segment.rule.id,version:segment.rule.version,scopeType:segment.rule.scopeType,scopeId:segment.rule.scopeId,effectiveFrom:segment.rule.effectiveFrom,value:segment.rule.value}}));
   return{personId:record.row.performedByPersonId,assignmentId:record.job.assignmentId,taskId:record.task.id,propertyId:record.task.propertyId,property:record.task.property,completionEventId:record.original.event.id,recordedCompletionAt:record.task.completedAt!,compensationId:first.source.rate!.id,configRuleId:first.rule.id,evidenceId:record.row.id,decisionId:record.row.decision!.id,rate:first.rate.toJSON(),amount:amount.amount.toJSON(),milliseconds:amount.milliseconds,witnesses,sourceSnapshot:{schemaVersion:1,kind:"ACTUAL_HOURLY_EARNINGS",taskId:record.task.id,personId:record.row.performedByPersonId,assignmentId:record.job.assignmentId,evidenceId:record.row.id,decisionId:record.row.decision!.id,completionEventId:record.original.event.id,completionEvent:record.original.event,runPolicyRuleId:policy.id,runPolicyVersion:policy.version,runPolicy:policy.value,workPolicyRuleId:record.row.policyRuleId,workPolicyVersion:record.row.policyRule.version,workPolicy:record.row.policySnapshot,intervals:record.row.intervals.map(interval=>({id:interval.id,startsAt:interval.startsAt.toISOString(),endsAt:interval.endsAt.toISOString()})),milliseconds:amount.milliseconds,witnesses,amount:amount.amount.toJSON()}};
  });
  const beneficiaryTotals=new Map<string,Money>();for(const line of lines)beneficiaryTotals.set(line.personId,(beneficiaryTotals.get(line.personId)??Money.zero(input.currency)).add(Money.of(line.amount.amount,input.currency)));
  for(const segment of retained)salaryChecks.push({action:"view",resource:{...employeeCompensationContractResource(ctx.organizationId,segment.source,segment.startsAt,segment.record.task.id),amount:beneficiaryTotals.get(segment.record.row.performedByPersonId)!.toJSON().amount}});
  const facts=employeeCompensationRunFacts(ctx.organizationId,{id:"",createdAt:now,currency:input.currency,lines:lines.map(line=>({...line,currency:input.currency,rate:line.rate.amount,amount:line.amount.amount,originalRateSources:line.witnesses.map(witness=>({occurredAt:witness.startsAt,compensation:{amount:witness.rate.amount,currency:input.currency}}))}))});
  await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,action,salaryChecks);
  const fingerprint=commandFingerprint({input,policy:{id:policy.id,version:policy.version,value:policy.value},lines});
  return{policy,window,lines,amount:facts.total.toJSON(),sourceFingerprint:fingerprint};
 };
 const prepared=await build(),recheck=async()=>{const current=await build();if(current.sourceFingerprint!==prepared.sourceFingerprint)throw new EmployeeCompensationRunConflictError();};
 return{...prepared,currency:input.currency,fromOn:input.fromOn,toOn:input.toOn,recheck};
}
