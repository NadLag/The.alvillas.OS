import type {LeadWorkEntry} from "@prisma/client";
import {decryptLeadWorkPayload,type LeadWorkPayloadBinding} from "../domain/lead-work-payload";
import {LeadWorkConflictError,leadWorkKindSchema,type NativeLeadWorkSubject} from "../domain/lead-work";

export function leadWorkBinding(row:LeadWorkEntry):LeadWorkPayloadBinding{
  return{organizationId:row.organizationId,leadId:row.leadId,revisionId:row.id,previousRevisionId:row.previousId,subjectId:row.subjectId,previousSubjectRevisionId:row.previousSubjectId,kind:leadWorkKindSchema.parse(row.kind),createdBy:row.createdBy,policyId:row.policyId,policyVersion:row.policyVersion,capturePolicyId:row.capturePolicyId,capturePolicyVersion:row.capturePolicyVersion,commandKey:row.commandKey};
}
export function retainedLeadWork(row:LeadWorkEntry,env?:NodeJS.ProcessEnv){
  const value=decryptLeadWorkPayload(row.encryptedPayload,leadWorkBinding(row),env);
  if(value.reviewFingerprint!==row.reviewFingerprint||value.kind!==row.kind||
    (value.kind==="ACTIVITY"&&(row.activityTypeKey!==value.activityTypeKey||row.occurredAt?.toISOString()!==value.occurredAt))||
    (value.kind==="REMINDER"&&(row.reminderState!==value.state||row.dueAt?.toISOString()!==value.dueAt||row.recipientId!==value.recipientId))||
    (value.kind==="ASSIGNMENT"&&row.representativeId!==value.representativeId))throw new LeadWorkConflictError();
  return value;
}
export function leadWorkSubject(row:LeadWorkEntry,env?:NodeJS.ProcessEnv):NativeLeadWorkSubject{
  const value=retainedLeadWork(row,env),identity={id:row.subjectId,revisionId:row.id};
  return value.kind==="REMINDER"?{...identity,kind:value.kind,state:value.state,dueAt:value.dueAt,recipientId:value.recipientId}:{...identity,kind:value.kind};
}
export function leadWorkReceipt(row:LeadWorkEntry,replayed:boolean){
  return{id:row.id,leadId:row.leadId,number:row.number,subjectId:row.subjectId,subjectNumber:row.subjectNumber,previousRevisionId:row.previousId,previousSubjectRevisionId:row.previousSubjectId,kind:leadWorkKindSchema.parse(row.kind),createdAt:row.createdAt.toISOString(),replayed};
}
