import {z} from "zod";
import {serviceAllocationReviewInput,serviceCollectionSourceInput} from "./service-allocation-command";
import {serviceAllocationSnapshotSchema} from "./service-allocation-snapshot-schema";

const id=z.uuid(),kind=z.enum(["SUPPLIER_INVOICE_LINE","EMPLOYEE_COST"]),money=z.object({amount:z.string(),currency:z.string()}).strict();
export const serviceAllocationCapabilitiesSchema=z.object({admit:z.boolean(),bind:z.boolean(),recognize:z.boolean(),adjust:z.boolean(),reverse:z.boolean()}).strict();
export const serviceAllocationWorkspaceReadSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("COLLECTIONS"),propertyId:id.optional(),after:id.optional()}).strict(),
 serviceCollectionSourceInput.extend({operation:z.literal("COLLECTION")}).strict(),
 z.object({operation:z.literal("DETAIL"),sourceId:id,beforeAdmissionVersion:z.number().int().positive().optional(),beforePostingVersion:z.number().int().positive().optional(),beforeBinding:id.optional()}).strict(),
 serviceCollectionSourceInput.extend({operation:z.literal("PROVIDERS"),kind,after:id.optional()}).strict(),
 serviceAllocationReviewInput.extend({operation:z.literal("REVIEW")}).strict()
]);
export const serviceAllocationCollectionsSchema=z.object({items:z.array(z.object({collectionId:id,completionEventId:id,sourceId:id.nullable(),propertyId:id,propertyName:z.string(),purpose:z.string(),completedAt:z.iso.datetime(),amount:money}).strict()).max(50),next:id.nullable()}).strict();
export const serviceAllocationCollectionSchema=z.object({collectionId:id,completionEventId:id,sourceId:id.nullable(),propertyId:id,propertyName:z.string(),purpose:z.string(),completedAt:z.iso.datetime(),amount:money,services:z.array(z.object({key:z.string(),currency:z.string(),providers:z.array(z.object({key:z.string(),kind}).strict())}).strict()).max(200),capabilities:serviceAllocationCapabilitiesSchema}).strict();
export const serviceAllocationReviewSchema=z.object({sourceId:id.nullable(),version:z.number().int().nonnegative(),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),snapshot:serviceAllocationSnapshotSchema}).strict();
export const serviceAllocationProvidersSchema=z.object({items:z.array(z.object({id,label:z.string(),kind,amount:money,version:z.number().int().nonnegative()}).strict()).max(50),next:id.nullable()}).strict();
export const serviceAllocationDetailSchema=z.object({sourceId:id,collectionId:id,completionEventId:id,capabilities:serviceAllocationCapabilitiesSchema,
 admissions:z.array(z.object({id,version:z.number().int().positive(),reason:z.string(),at:z.iso.datetime(),snapshot:serviceAllocationSnapshotSchema}).strict()).max(50),admissionsNext:z.number().int().positive().nullable(),
 bindings:z.array(z.object({id,costId:id,kind,version:z.number().int().positive(),state:z.enum(["ATTACHED","RELEASED"]),reason:z.string(),at:z.iso.datetime(),current:z.boolean()}).strict()).max(50),bindingsNext:id.nullable(),
 postings:z.array(z.object({id,admissionId:id,transactionId:id,version:z.number().int().positive(),kind:z.enum(["RECOGNITION","REVERSAL"]),reason:z.string(),at:z.iso.datetime(),occurredAt:z.iso.datetime(),reversesPostingId:id.nullable(),adjustment:z.object({periodId:id,periodEventId:id,sourceOccurredAt:z.iso.datetime()}).strict().nullable(),lines:z.array(z.object({account:z.string(),ownerName:z.string().nullable(),side:z.enum(["DEBIT","CREDIT"]),amount:money,bucket:z.string(),dimensions:z.record(z.string(),z.unknown())}).strict())}).strict()).max(50),postingsNext:z.number().int().positive().nullable(),
 latestAdmissionId:id.nullable(),latestAdmissionVersion:z.number().int().nonnegative(),latestPostingVersion:z.number().int().nonnegative(),activePostingId:id.nullable()
}).strict();
export type ServiceAllocationCollections=z.infer<typeof serviceAllocationCollectionsSchema>;
export type ServiceAllocationCollection=z.infer<typeof serviceAllocationCollectionSchema>;
export type ServiceAllocationDetail=z.infer<typeof serviceAllocationDetailSchema>;
