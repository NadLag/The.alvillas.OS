import { z } from "zod";
import { EmployeeCompensationClaimSourceError } from "./employee-compensation-claim";

export type EmployeeEarningSourceIdentityInput={id?:string;personId?:string;percentageWitnesses?:readonly {isEarningBase:boolean;posting:{id:string}}[];earningKind?:string;assignmentId?:string;earningPeriodKey?:string|null;workTimeEvidenceId?:string|null;workTimeDecisionId?:string|null;taskId:string|null;completionEventId:string|null;propertyId:string|null};
type Source=EmployeeEarningSourceIdentityInput;
/** Actual work and contract periods have distinct durable identities; a monthly source never invents a job. */
export function employeeCompensationSourceIdentity(source:Source){
 if(source.earningKind==="PERCENTAGE"){
  const postingIds=source.percentageWitnesses?.filter(row=>row.isEarningBase).map(row=>row.posting.id).sort()??[];
  if(![source.id,source.personId,source.assignmentId,...postingIds].every(value=>z.uuid().safeParse(value).success)||!postingIds.length||new Set(postingIds).size!==postingIds.length||source.completionEventId!==null||source.earningPeriodKey!=null||source.workTimeEvidenceId!=null||source.workTimeDecisionId!=null||(source.propertyId!==null&&!z.uuid().safeParse(source.propertyId).success)||(source.taskId!==null&&(!z.uuid().safeParse(source.taskId).success||source.propertyId===null)))throw new EmployeeCompensationClaimSourceError();
  return{kind:"PERCENTAGE" as const,key:"percentage:"+source.personId+":"+source.id,completionEventId:null,assignmentId:source.assignmentId!,month:null,personId:source.personId!,postingIds};
 }
 if(source.earningKind===undefined||source.earningKind==="PER_JOB"||source.earningKind==="PER_HOUR"){
  if(!z.uuid().safeParse(source.taskId).success||!z.uuid().safeParse(source.completionEventId).success||!z.uuid().safeParse(source.propertyId).success||source.earningPeriodKey!=null)throw new EmployeeCompensationClaimSourceError();
  if(source.earningKind==="PER_HOUR"){
   if(!z.uuid().safeParse(source.workTimeEvidenceId).success||!z.uuid().safeParse(source.workTimeDecisionId).success||!z.uuid().safeParse(source.assignmentId).success)throw new EmployeeCompensationClaimSourceError();
   return{kind:"PER_HOUR" as const,key:source.completionEventId!,completionEventId:source.completionEventId!,assignmentId:source.assignmentId!,month:null,evidenceId:source.workTimeEvidenceId!,decisionId:source.workTimeDecisionId!};
  }
  if(source.workTimeEvidenceId!=null||source.workTimeDecisionId!=null)throw new EmployeeCompensationClaimSourceError();
  return{kind:"PER_JOB" as const,key:source.completionEventId!,completionEventId:source.completionEventId!,assignmentId:null,month:null};
 }
 if(source.earningKind!=="PER_MONTH"||source.completionEventId!==null||!z.uuid().safeParse(source.assignmentId).success||!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(source.earningPeriodKey??"")||(source.propertyId!==null&&!z.uuid().safeParse(source.propertyId).success)||(source.taskId!==null&&(!z.uuid().safeParse(source.taskId).success||source.propertyId===null)))throw new EmployeeCompensationClaimSourceError();
 return{kind:"PER_MONTH" as const,key:"monthly:"+source.assignmentId+":"+source.earningPeriodKey,completionEventId:null,assignmentId:source.assignmentId!,month:source.earningPeriodKey!};
}

export function employeeCompensationSourceGroups(sources:readonly Source[]){
 const identities=sources.map(employeeCompensationSourceIdentity);
 return{keys:identities.flatMap(source=>source.kind==="PERCENTAGE"?source.postingIds.map(id=>"percentage:"+source.personId+":"+id):[source.key]),completionEventIds:identities.flatMap(source=>source.kind==="PER_JOB"||source.kind==="PER_HOUR"?[source.completionEventId]:[]),monthly:identities.flatMap(source=>source.kind==="PER_MONTH"?[{assignmentId:source.assignmentId,month:source.month}]:[]),percentage:identities.flatMap(source=>source.kind==="PERCENTAGE"?source.postingIds.map(postingId=>({personId:source.personId,postingId})):[])};
}
