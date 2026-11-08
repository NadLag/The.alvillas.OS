import type {LeadWorkEntry} from "@prisma/client";
import {z} from "zod";
import {decryptLeadWorkPayload,type LeadWorkPayloadBinding} from "../domain/lead-work-payload";
import {LeadWorkConflictError,leadWorkKindSchema,leadWorkPolicySchema,type NativeLeadWorkSubject} from "../domain/lead-work";
import {leadWorkReceiptSchema} from "../domain/lead-work-view";

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
  return leadWorkReceiptSchema.parse({id:row.id,leadId:row.leadId,number:row.number,subjectId:row.subjectId,subjectNumber:row.subjectNumber,previousRevisionId:row.previousId,previousSubjectRevisionId:row.previousSubjectId,kind:leadWorkKindSchema.parse(row.kind),createdAt:row.createdAt.toISOString(),replayed});
}
export function leadWorkHistoryItem(row:LeadWorkEntry,currentSubject:boolean,env?:NodeJS.ProcessEnv){
  const command=retainedLeadWork(row,env),policy=z.object({value:leadWorkPolicySchema}).parse(row.policySnapshot),activityLabel=command.kind==="ACTIVITY"?policy.value.activity_types.find(type=>type.key===command.activityTypeKey)?.label??null:null;
  if(command.kind==="ACTIVITY"&&!activityLabel)throw new LeadWorkConflictError();return{...leadWorkReceipt(row,false),command,representativePersonId:row.representativePersonId,currentSubject,activityLabel};
}
