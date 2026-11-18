import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";

const id=z.uuid().transform(value=>value.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const workOrderRegistrationIntentSchema=z.object({issueId:id,taskId:id,reason:z.string().trim().min(6).max(1000)}).strict();
export const workOrderRegistrationCommandSchema=z.object({intent:workOrderRegistrationIntentSchema,reviewFingerprint:hash,idempotencyKey:id}).strict();
export const workOrderRegistrationReceiptSchema=z.object({schemaVersion:z.literal(1),organizationId:id,actorId:id,taskId:id,propertyId:id,intent:workOrderRegistrationIntentSchema,idempotencyKey:id,nativeFingerprint:hash,sourceFingerprint:hash,reviewFingerprint:hash,requestHash:hash,createdAt:z.iso.datetime()}).strict().superRefine((value,context)=>{
 if(value.taskId!==value.intent.taskId)context.addIssue({code:"custom",message:"The original maintenance task is the work order"});
});
export type WorkOrderRegistrationReceipt=z.infer<typeof workOrderRegistrationReceiptSchema>;
export const workOrderRegistrationPublishedSchema=workOrderRegistrationReceiptSchema.safeExtend({replayed:z.boolean()}).strict();
export const workOrderRegistrationCancellationSchema=z.object({schemaVersion:z.literal(1),organizationId:id,actorId:id,issueId:id,taskId:id.nullable(),idempotencyKey:id}).strict();
export const workOrderTaskSchema=z.object({id,propertyId:id,reservationId:id.nullable(),version:z.number().int().positive(),type:z.literal("MAINTENANCE"),title:localizedTextSchema,priority:z.enum(["LOW","NORMAL","HIGH","URGENT"]),state:z.enum(["PLANNED","ASSIGNED","IN_PROGRESS","COMPLETED","SKIPPED","CANCELLED","BLOCKED"]),dueDate:z.iso.date(),assignedToMe:z.boolean(),completedAt:z.iso.datetime().nullable()}).strict();
export class WorkOrderAccessError extends Error{constructor(){super("maintenance_work_order_unavailable");}}
export class WorkOrderConflictError extends Error{constructor(){super("maintenance_work_order_changed");}}
const stamp=z.string().regex(/^[a-f0-9]{64}$/u);
export const workOrderRegistrationReviewSchema=z.object({authorizationStamp:stamp,intent:workOrderRegistrationIntentSchema,reviewFingerprint:hash,issue:z.object({id,title:z.string()}).strict(),task:workOrderTaskSchema}).strict();
export const workOrderTaskChoicesSchema=z.object({authorizationStamp:stamp,items:z.array(workOrderTaskSchema).max(20),next:z.string().nullable()}).strict();
export const workOrderListSchema=z.object({authorizationStamp:stamp,propertyId:id,canRegister:z.boolean(),items:z.array(z.discriminatedUnion("state",[z.object({state:z.literal("VISIBLE"),task:workOrderTaskSchema,registeredAt:z.iso.datetime()}).strict(),z.object({state:z.literal("MASKED")}).strict()])).max(20),next:z.string().nullable()}).strict();
export const workOrderRegistrationRecoverySchema=z.discriminatedUnion("recorded",[z.object({recorded:z.literal(true),receipt:workOrderRegistrationReceiptSchema}).strict(),z.object({recorded:z.literal(false),receipt:z.null()}).strict()]);
export const workOrderCommandStatusSchema=z.object({organizationId:id,actorId:id,issueId:id,idempotencyKey:id,state:z.enum(["RECORDED","CANCELLED","UNKNOWN"])}).strict();
