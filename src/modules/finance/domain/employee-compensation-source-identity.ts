import { z } from "zod";
import { EmployeeCompensationClaimSourceError } from "./employee-compensation-claim";

type Source={earningKind?:string;assignmentId?:string;earningPeriodKey?:string|null;taskId:string|null;completionEventId:string|null;propertyId:string|null};
/** Actual work and contract periods have distinct durable identities; a monthly source never invents a job. */
export function employeeCompensationSourceIdentity(source:Source){
 if(source.earningKind===undefined||source.earningKind==="PER_JOB"){
  if(!z.uuid().safeParse(source.taskId).success||!z.uuid().safeParse(source.completionEventId).success||!z.uuid().safeParse(source.propertyId).success||source.earningPeriodKey!=null)throw new EmployeeCompensationClaimSourceError();
  return{kind:"PER_JOB" as const,key:source.completionEventId!,completionEventId:source.completionEventId!,assignmentId:null,month:null};
 }
 if(source.earningKind!=="PER_MONTH"||source.completionEventId!==null||!z.uuid().safeParse(source.assignmentId).success||!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(source.earningPeriodKey??"")||(source.propertyId!==null&&!z.uuid().safeParse(source.propertyId).success)||(source.taskId!==null&&(!z.uuid().safeParse(source.taskId).success||source.propertyId===null)))throw new EmployeeCompensationClaimSourceError();
 return{kind:"PER_MONTH" as const,key:"monthly:"+source.assignmentId+":"+source.earningPeriodKey,completionEventId:null,assignmentId:source.assignmentId!,month:source.earningPeriodKey!};
}

export function employeeCompensationSourceGroups(sources:readonly Source[]){
 const identities=sources.map(employeeCompensationSourceIdentity);
 return{keys:identities.map(source=>source.key),completionEventIds:identities.flatMap(source=>source.kind==="PER_JOB"?[source.completionEventId]:[]),monthly:identities.flatMap(source=>source.kind==="PER_MONTH"?[{assignmentId:source.assignmentId,month:source.month}]:[])};
}
