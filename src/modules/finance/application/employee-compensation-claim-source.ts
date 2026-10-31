import { prepareEmployeeMonthlyRunSources } from "./employee-monthly-run-source";
import { prepareEmployeeHourlyRunSources } from "./employee-hourly-run-source";
import type { FinanceActorContext } from "./finance-access";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { sameSubmittedCostPolicy } from "../domain/submitted-cost-allocation";
import { z } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { EmployeeCompensationClaimSourceError } from "../domain/employee-compensation-claim";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import type { CompensationRunRecord } from "../infrastructure/employee-compensation-run-repository";
import { validateEmployeeCompensationAssignment,validateEmployeeCompensationRate,validateEmployeeCompletedWorkSource } from "./employee-compensation-source";

/** A saved expectation must still bind the canonical earning terms when it becomes a new claim proposal. */
export async function retainCurrentEmployeeClaimWork(organizationId:string,run:CompensationRunRecord,tx:TenantTransaction,actor?:FinanceActorContext){
  if(run.earningKind==="PER_HOUR"){
   if(!actor)throw new EmployeeCompensationClaimSourceError();
   const runs=new EmployeeCompensationRunRepository(tx,organizationId),snapshots=await runs.sourceSnapshots(run.id);
   const current=await prepareEmployeeHourlyRunSources(actor,{fromOn:run.fromOn.toISOString().slice(0,10),toOn:run.toOn.toISOString().slice(0,10),currency:run.currency,jobs:run.lines.map(line=>({taskId:line.taskId,assignmentId:line.assignmentId,evidenceId:line.workTimeEvidenceId,decisionId:line.workTimeDecisionId,confirmedAssignment:true}))},tx,"edit"),byTask=new Map(current.lines.map(line=>[line.taskId,line]));
   for(const line of run.lines){const actual=line.taskId?byTask.get(line.taskId):null,snapshot=snapshots.find(row=>row.id===line.id);if(!actual||!snapshot||line.earningKind!=="PER_HOUR"||line.compensationId!==actual.compensationId||line.configRuleId!==actual.configRuleId||line.personId!==actual.personId||line.propertyId!==actual.propertyId||line.completionEventId!==actual.completionEventId||line.workTimeEvidenceId!==actual.evidenceId||line.workTimeDecisionId!==actual.decisionId||line.recordedCompletionAt.getTime()!==actual.recordedCompletionAt.getTime()||!Money.of(line.amount.toString(),run.currency).equals(Money.of(actual.amount.amount,run.currency))||!sameSubmittedCostPolicy(snapshot.sourceSnapshot,JSON.parse(JSON.stringify(actual.sourceSnapshot))))throw new EmployeeCompensationClaimSourceError();}
   const recheck=async()=>{await current.recheck();if(!sameSubmittedCostPolicy(await runs.sourceSnapshots(run.id),snapshots))throw new EmployeeCompensationClaimSourceError();};await recheck();return recheck;
  }
  if(run.earningKind==="PER_MONTH"){
   if(!actor)throw new EmployeeCompensationClaimSourceError();const runs=new EmployeeCompensationRunRepository(tx,organizationId),snapshots=await runs.sourceSnapshots(run.id),current=await prepareEmployeeMonthlyRunSources(actor,{month:run.fromOn.toISOString().slice(0,7),currency:run.currency,assignments:run.lines.map(line=>({assignmentId:line.assignmentId,confirmedAssignment:true}))},tx,"edit"),byAssignment=new Map(current.lines.map(line=>[line.assignmentId,line]));
   for(const line of run.lines){const actual=byAssignment.get(line.assignmentId),snapshot=snapshots.find(row=>row.id===line.id);if(!actual||!snapshot||line.earningKind!=="PER_MONTH"||line.compensationId!==actual.compensationId||line.configRuleId!==actual.configRuleId||line.personId!==actual.personId||line.propertyId!==actual.propertyId||line.taskId!==actual.taskId||line.completionEventId!==null||!Money.of(line.amount.toString(),run.currency).equals(Money.of(actual.amount.amount,run.currency))||!sameSubmittedCostPolicy(monthlyMaterial(snapshot.sourceSnapshot),monthlyMaterial(JSON.parse(JSON.stringify(actual.sourceSnapshot)))))throw new EmployeeCompensationClaimSourceError();}
   const recheck=async()=>{await current.recheck();const latest=await runs.sourceSnapshots(run.id);if(!sameSubmittedCostPolicy(latest,snapshots))throw new EmployeeCompensationClaimSourceError();};await recheck();return recheck;
  }
  const lines=run.lines.map(line=>{if(!line.taskId||!line.completionEventId||!line.propertyId||!line.property)throw new EmployeeCompensationClaimSourceError();return{...line,taskId:line.taskId,completionEventId:line.completionEventId,propertyId:line.propertyId,property:line.property};});
  const repository=new EmployeeCompensationRepository(tx,organizationId),config=new ConfigRuleRepository(tx,organizationId);
  const entries=lines.map(line=>({key:line.id,assignmentId:line.assignmentId,earnedAt:line.recordedCompletionAt}));
  const groups=new Map(entries.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}]));
  const read=async()=>{
    const tasks=(await repository.completedWorks(lines.map(line=>line.taskId))).sort((a,b)=>a.id.localeCompare(b.id)),taskMap=new Map(tasks.map(task=>[task.id,task]));
    const sources=await repository.sources(entries);
    // Changed contracts are unavailable; no replacement private rate is disclosed through an old expectation.
    for(const line of lines){const source=sources.get(line.id),task=taskMap.get(line.taskId);
      if(!source?.rate||!task||source.rate.id!==line.compensationId||source.rate.configRuleId!==line.configRuleId||source.assignment.personId!==line.personId||
        source.rate.currency!==line.currency||!Money.of(source.rate.amount.toString(),line.currency).equals(Money.of(line.rate.toString(),line.currency)))throw new EmployeeCompensationClaimSourceError();
      validateEmployeeCompensationAssignment(source,line.recordedCompletionAt);const original=validateEmployeeCompletedWorkSource(task,source);
      if(original.event.id!==line.completionEventId||task.completedAt?.getTime()!==line.recordedCompletionAt.getTime())throw new EmployeeCompensationClaimSourceError();
    }
    const rules=await config.resolveDatedScopeGroups("staff.compensation",groups);
    for(const entry of entries)validateEmployeeCompensationRate(sources.get(entry.key)!,rules.get(entry.key)??null);
    return JSON.stringify({tasks,sources:[...sources],rules:[...rules]});
  };
  const original=await read();
  return async()=>{if(await read()!==original)throw new EmployeeCompensationClaimSourceError();};
}

/** Later retirement does not rewrite past daily eligibility; rates, identities and chosen rules remain binding. */
function monthlyMaterial(raw:unknown){const row=z.object({schemaVersion:z.literal(1),kind:z.literal("MONTHLY_CONTRACT_EARNINGS"),month:z.string(),assignmentId:z.string(),personId:z.string(),policyRuleId:z.string(),policyVersion:z.number(),policy:z.unknown(),amount:z.unknown(),days:z.array(z.object({on:z.string(),eligible:z.boolean(),assignment:z.object({id:z.string(),personId:z.string(),roleId:z.string(),scopeType:z.string(),scopeId:z.string().nullable()}),compensation:z.unknown().nullable(),rule:z.object({id:z.string(),version:z.number(),scopeType:z.string(),scopeId:z.string().nullable(),value:z.unknown()}).nullable()}))}).parse(raw);return row;}
