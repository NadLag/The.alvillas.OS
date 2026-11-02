import {z} from "zod";
import {receivableAssignmentViewSchema} from "./receivable-assignment";
import {receivableCollectionMethodSchema} from "./receivable-collection-policy";
import {receivableCollectionViewSchema} from "./receivable-collection";
const id=z.uuid().transform(value=>value.toLowerCase());
export const receivableCollectionEditorInput=z.object({assignmentId:id,after:z.string().min(1).max(2048).optional(),search:z.string().trim().max(120).default("")}).strict();
export const receivableCollectionEditorSchema=z.object({source:z.object({assignment:receivableAssignmentViewSchema,outstandingAmount:receivableAssignmentViewSchema.shape.amount,methods:z.array(receivableCollectionMethodSchema),accounts:z.array(z.object({id,name:z.string(),code:z.string()}).strict()).max(50),next:z.string().min(1).max(2048).nullable(),canCollect:z.boolean()}).strict()}).strict();
export const receivableCollectionHistoryInput=z.object({assignmentId:id.optional(),after:z.string().min(1).max(2048).optional()}).strict();
export const receivableCollectionHistorySchema=z.object({source:z.object({items:z.array(receivableCollectionViewSchema).max(25),next:z.string().min(1).max(2048).nullable()}).strict()}).strict();
