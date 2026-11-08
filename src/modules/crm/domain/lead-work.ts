import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {configSlugSchema} from "@/platform/config/identifiers";
import {leadCaptureMaximumRequestBytes,leadFieldsSchema,LeadValidationError} from "./lead-capture";
import {leadStageReasonSchema} from "./lead-pipeline";

const uuid=z.uuid().transform(value=>value.toLowerCase()),integer=z.number().int().min(0).max(2147483647);
const instant=z.iso.datetime({precision:3}),summary=leadStageReasonSchema.pipe(z.string().max(240));
export const leadWorkPolicyKey="crm.lead_work";
export const leadWorkKinds=["ACTIVITY","REMINDER","ASSIGNMENT"]as const;
export const leadWorkKindSchema=z.enum(leadWorkKinds);
export const leadReminderStateSchema=z.enum(["OPEN","COMPLETED","CANCELLED"]);
const reminderTransition=z.object({from:leadReminderStateSchema,to:leadReminderStateSchema}).strict();
export const leadWorkPolicySchema=z.object({
  source:z.literal("NATIVE_PRIVATE_LEAD_WORK"),history:z.literal("APPEND_ONLY_ACTIVITIES_REMINDERS_ASSIGNMENTS"),
  activity_types:z.array(z.object({key:configSlugSchema,label:localizedTextSchema,notes_required:z.boolean()}).strict()).min(1).max(1000).refine(values=>new Set(values.map(value=>value.key)).size===values.length),
  activity_future_seconds:integer,
  reminders:z.object({past_due:z.enum(["REJECT","ALLOW_DUE"]),maximum_future_seconds:integer,transitions:z.array(reminderTransition).max(9).refine(values=>new Set(values.map(value=>value.from+":"+value.to)).size===values.length)}).strict(),
  admission:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict();
export type LeadWorkPolicy=z.infer<typeof leadWorkPolicySchema>;

const base=z.object({leadId:uuid,previousRevisionId:uuid.nullable(),subjectId:uuid.nullable(),previousSubjectRevisionId:uuid.nullable()});
const activity=base.extend({kind:z.literal("ACTIVITY"),activityTypeKey:configSlugSchema,occurredAt:instant,summary,notes:leadFieldsSchema.shape.notes}).strict();
const reminder=base.extend({kind:z.literal("REMINDER"),state:leadReminderStateSchema,dueAt:instant,recipientId:uuid,summary,notes:leadFieldsSchema.shape.notes}).strict();
const assignment=base.extend({kind:z.literal("ASSIGNMENT"),representativeId:uuid.nullable()}).strict();
const envelope={idempotencyKey:uuid,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),reason:leadStageReasonSchema};
function subjectPair(value:{subjectId:string|null;previousSubjectRevisionId:string|null;kind:string;state?:string},ctx:z.RefinementCtx){
  if((value.subjectId===null)!==(value.previousSubjectRevisionId===null))ctx.addIssue({code:"custom",message:"lead_work_subject_revision_required"});
  if(value.kind==="REMINDER"&&value.subjectId===null&&value.state!=="OPEN")ctx.addIssue({code:"custom",message:"lead_reminder_initial_open_required"});
}
export const leadWorkDraftSchema=z.discriminatedUnion("kind",[activity,reminder,assignment]).superRefine(subjectPair);
export const leadWorkCommandSchema=z.discriminatedUnion("kind",[activity.extend(envelope),reminder.extend(envelope),assignment.extend(envelope)]).superRefine(subjectPair);
export type LeadWorkDraft=z.infer<typeof leadWorkDraftSchema>;
export type LeadWorkCommand=z.infer<typeof leadWorkCommandSchema>;
export class LeadWorkConflictError extends Error{constructor(){super("lead_work_conflict");}}

function bounded<T>(value:T):T{
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>leadCaptureMaximumRequestBytes)throw new LeadValidationError();return value;
}
function projection(value:LeadWorkDraft):LeadWorkDraft{
  const common={leadId:value.leadId,previousRevisionId:value.previousRevisionId,subjectId:value.subjectId,previousSubjectRevisionId:value.previousSubjectRevisionId};
  if(value.kind==="ASSIGNMENT")return{...common,kind:value.kind,representativeId:value.representativeId};
  const details={summary:value.summary,...value.notes!==undefined?{notes:value.notes}:{}};
  return value.kind==="ACTIVITY"?{...common,kind:value.kind,activityTypeKey:value.activityTypeKey,occurredAt:value.occurredAt,...details}:{...common,kind:value.kind,state:value.state,dueAt:value.dueAt,recipientId:value.recipientId,...details};
}
export function canonicalLeadWorkDraft(raw:unknown):LeadWorkDraft{return bounded(projection(leadWorkDraftSchema.parse(raw)));}
export function canonicalLeadWorkCommand(raw:unknown):LeadWorkCommand{
  const value=leadWorkCommandSchema.parse(raw);return bounded({...projection(value),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason});
}
export function leadWorkDraftFromCommand(raw:LeadWorkCommand):LeadWorkDraft{return bounded(projection(leadWorkCommandSchema.parse(raw)));}
/** Account eligibility, current authority and native predecessors are checked by the application service. */
export function configuredLeadWorkDraft(raw:unknown,rawPolicy:LeadWorkPolicy,now:Date):LeadWorkDraft{
  const value=canonicalLeadWorkDraft(raw),policy=leadWorkPolicySchema.parse(rawPolicy),clock=now.getTime();if(!Number.isFinite(clock))throw new LeadValidationError();
  if(value.kind==="ACTIVITY"){
    const type=policy.activity_types.find(type=>type.key===value.activityTypeKey);if(!type||type.notes_required&&!value.notes||Date.parse(value.occurredAt)>clock+policy.activity_future_seconds*1000)throw new LeadValidationError();
  }else if(value.kind==="REMINDER"&&value.state==="OPEN"){
    const due=Date.parse(value.dueAt);if(policy.reminders.past_due==="REJECT"&&due<clock||due>clock+policy.reminders.maximum_future_seconds*1000)throw new LeadValidationError();
  }
  return value;
}
export function requireLeadWorkSubject(input:LeadWorkDraft,subject:{id:string;revisionId:string;kind:LeadWorkDraft["kind"]}|null){
  if(input.subjectId===null){if(subject)throw new LeadWorkConflictError();return;}
  if(!subject||subject.id!==input.subjectId||subject.revisionId!==input.previousSubjectRevisionId||subject.kind!==input.kind)throw new LeadWorkConflictError();
}
export type NativeLeadWorkSubject={id:string;revisionId:string;kind:"ACTIVITY"|"ASSIGNMENT"}|{id:string;revisionId:string;kind:"REMINDER";state:z.infer<typeof leadReminderStateSchema>;dueAt:string;recipientId:string};
export function requireConfiguredLeadWorkSubject(input:LeadWorkDraft,subject:NativeLeadWorkSubject|null,rawPolicy:LeadWorkPolicy){
  requireLeadWorkSubject(input,subject);const policy=leadWorkPolicySchema.parse(rawPolicy);
  if(input.kind!=="REMINDER"||subject===null)return;if(subject.kind!=="REMINDER")throw new LeadWorkConflictError();
  if(!policy.reminders.transitions.some(transition=>transition.from===subject.state&&transition.to===input.state))throw new LeadValidationError();
  if(input.state!=="OPEN"&&(input.dueAt!==subject.dueAt||input.recipientId!==subject.recipientId))throw new LeadValidationError();
}
