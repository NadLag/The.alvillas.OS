import {z} from "zod";
import {leadWorkKindSchema,leadWorkCommandSchema,leadWorkPolicySchema} from "./lead-work";

const uuid=z.uuid(),revision=uuid.nullable();
export const leadWorkReceiptSchema=z.object({id:uuid,leadId:uuid,number:z.number().int().positive(),subjectId:uuid,subjectNumber:z.number().int().positive(),previousRevisionId:revision,previousSubjectRevisionId:revision,kind:leadWorkKindSchema,createdAt:z.iso.datetime(),replayed:z.boolean()});
export const leadWorkHistorySchema=z.object({leadId:uuid,workRevisionId:revision,workHistory:z.array(leadWorkReceiptSchema.extend({command:leadWorkCommandSchema,representativePersonId:revision,currentSubject:z.boolean()})).max(20),next:z.number().int().positive().nullable()});
export const leadWorkOptionsSchema=z.object({leadId:uuid,workRevisionId:revision,assignment:leadWorkReceiptSchema.extend({representativeId:revision}).nullable(),activityTypes:leadWorkPolicySchema.shape.activity_types,reminderTransitions:leadWorkPolicySchema.shape.reminders.shape.transitions,canEdit:z.boolean(),canAssign:z.boolean(),accountId:uuid});
export const leadWorkCandidatesSchema=z.object({accounts:z.array(z.object({id:uuid,displayName:z.string()})).max(20)});
