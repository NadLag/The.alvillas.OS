import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { EmployeeCompensationClaimSourceError } from "../domain/employee-compensation-claim";
import { EmployeeCompensationRepository } from "../infrastructure/employee-compensation-repository";
import type { CompensationRunRecord } from "../infrastructure/employee-compensation-run-repository";
import { validateEmployeeCompensationAssignment,validateEmployeeCompensationRate,validateEmployeeCompletedWorkSource } from "./employee-compensation-source";

/** A saved expectation must still bind the canonical earning terms when it becomes a new claim proposal. */
export async function retainCurrentEmployeeClaimWork(organizationId:string,run:CompensationRunRecord,tx:TenantTransaction){
  const repository=new EmployeeCompensationRepository(tx,organizationId),config=new ConfigRuleRepository(tx,organizationId);
  const entries=run.lines.map(line=>({key:line.id,assignmentId:line.assignmentId,earnedAt:line.recordedCompletionAt}));
  const groups=new Map(entries.map(entry=>[entry.key,{asOf:entry.earnedAt,scopes:[{scopeType:"role_assignment",scopeId:entry.assignmentId}]}]));
  const read=async()=>{
    const tasks=(await repository.completedWorks(run.lines.map(line=>line.taskId))).sort((a,b)=>a.id.localeCompare(b.id)),taskMap=new Map(tasks.map(task=>[task.id,task]));
    const sources=await repository.sources(entries);
    // Changed contracts are unavailable; no replacement private rate is disclosed through an old expectation.
    for(const line of run.lines){const source=sources.get(line.id),task=taskMap.get(line.taskId);
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
