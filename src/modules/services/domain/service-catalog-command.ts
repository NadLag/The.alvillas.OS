import {z} from "zod";
import {serviceCatalogPublishEntrySchema} from "./service-catalog";
import {configSlugSchema} from "@/platform/config/identifiers";

export const serviceCatalogScopeSchema=z.object({propertyId:z.uuid(),ownerId:z.uuid().optional()}).strict();
export const serviceCatalogDraftSchema=z.object({scope:serviceCatalogScopeSchema,entry:serviceCatalogPublishEntrySchema,reason:z.string().trim().min(6).max(500)}).strict();
export const serviceCatalogCommandSchema=z.object({draft:serviceCatalogDraftSchema,reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),idempotencyKey:z.uuid()}).strict();
export const serviceCatalogPageSchema=z.object({scope:serviceCatalogScopeSchema,after:configSlugSchema.optional(),query:z.string().trim().max(100).default("")}).strict();
export const serviceCatalogHistorySchema=z.object({scope:serviceCatalogScopeSchema,afterVersion:z.number().int().positive().optional()}).strict();
export const serviceCatalogVersionSchema=z.object({scope:serviceCatalogScopeSchema,ruleId:z.uuid(),after:configSlugSchema.optional(),query:z.string().trim().max(100).default("")}).strict();
export const serviceCatalogRecoverSchema=z.object({scope:serviceCatalogScopeSchema,idempotencyKey:z.uuid()}).strict();
export const serviceCatalogPublished="services.catalog.published";
export const serviceCatalogReceiptSchema=z.object({
 schemaVersion:z.literal(1),actorId:z.uuid(),propertyId:z.uuid(),ownerId:z.uuid().nullable(),
 serviceKey:configSlugSchema,ruleId:z.uuid(),ruleVersion:z.number().int().positive(),commandHash:z.string().regex(/^[a-f0-9]{64}$/u),reviewFingerprint:z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
export type ServiceCatalogCommand=z.infer<typeof serviceCatalogCommandSchema>;
