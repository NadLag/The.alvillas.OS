import {z} from "zod";
import {authorizationCapSchema} from "@/platform/authz/authorization-cap";
import {documentUploadInput} from "@/modules/documents/domain/document-command";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
import {onboardingOwnerPackagePolicySchema} from "./onboarding-owner-package-policy";

export const onboardingOwnerPackageRequested="onboarding.owner_package_requested";
export const onboardingOwnerPackageProtocol="NATIVE_ONBOARDING_OWNER_PACKAGE_V1";
export const onboardingOwnerPackageLocales=["en","fr","ar"]as const;
const locale=z.enum(onboardingOwnerPackageLocales),sha=onboardingFingerprintSchema,id=onboardingIdSchema;
export const onboardingOwnerPackageDraftSchema=z.object({sessionId:id,reviewRevisionId:id}).strict();
export const onboardingOwnerPackageCommandSchema=onboardingOwnerPackageDraftSchema.extend({idempotencyKey:id,reviewFingerprint:sha,reason:documentUploadInput.shape.reason});
export type OnboardingOwnerPackageCommand=z.infer<typeof onboardingOwnerPackageCommandSchema>;
export const onboardingOwnerPackageSourceSchema=z.object({source:z.literal(onboardingOwnerPackageProtocol),organizationId:id,sessionId:id,reviewRevisionId:id,ownerId:id,propertyId:id,agreementId:id,reviewSourceFingerprint:sha,nativePackageFingerprint:sha,contentId:id,contentVersion:z.number().int().positive()}).strict();
export const onboardingOwnerPackagePlanItemSchema=z.object({locale,instanceId:id,documentId:id,templateVersionId:id,templateSha256:sha,commandKeyFingerprint:sha,sourceFingerprint:sha,reviewFingerprint:sha}).strict();
export const onboardingOwnerPackagePlanSchema=z.array(onboardingOwnerPackagePlanItemSchema).min(2).max(3).superRefine((rows,context)=>{
 for(const key of["locale","instanceId","documentId","templateVersionId","commandKeyFingerprint"]as const)if(new Set(rows.map(row=>row[key])).size!==rows.length)context.addIssue({code:"custom",message:"distinct_native_owner_package_documents_required",path:[key]});
 if(!rows.some(row=>row.locale==="en")||!rows.some(row=>row.locale==="fr"))context.addIssue({code:"custom",message:"actual_english_and_french_owner_package_required"});
});
export const onboardingOwnerPackagePolicySnapshotSchema=z.object({id,version:z.number().int().positive(),value:onboardingOwnerPackagePolicySchema}).strict();
export const onboardingOwnerPackageOriginalSchema=z.object({protocol:z.literal(onboardingOwnerPackageProtocol),command:onboardingOwnerPackageCommandSchema,source:onboardingOwnerPackageSourceSchema,plan:onboardingOwnerPackagePlanSchema,policySnapshot:onboardingOwnerPackagePolicySnapshotSchema,authorizationCap:authorizationCapSchema}).strict().superRefine((value,context)=>{
 if(value.command.sessionId!==value.source.sessionId||value.command.reviewRevisionId!==value.source.reviewRevisionId||value.authorizationCap.organizationId!==value.source.organizationId)context.addIssue({code:"custom",message:"original_native_owner_package_source_required"});
 const templates=value.policySnapshot.value.templates;if(value.plan.length!==Object.values(templates).length||value.plan.some(row=>templates[row.locale]!==row.templateVersionId))context.addIssue({code:"custom",message:"actual_configured_owner_package_variants_required"});
});
export type OnboardingOwnerPackageOriginal=z.infer<typeof onboardingOwnerPackageOriginalSchema>;
const receiptItem=z.object({locale,instanceId:id,documentId:id,versionId:id.nullable(),state:z.enum(["PENDING","COMPLETE","SOURCE_CHANGED"])}).strict().refine(value=>(value.state==="COMPLETE")===Boolean(value.versionId));
export const onboardingOwnerPackageReceiptSchema=z.object({recorded:z.literal(true),packageId:id,sessionId:id,reviewRevisionId:id,propertyId:id,idempotencyKey:id,requestedAt:z.iso.datetime(),state:z.enum(["PENDING","COMPLETE","SOURCE_CHANGED"]),documents:z.array(receiptItem).min(2).max(3),replayed:z.boolean()}).strict().superRefine((value,context)=>{
 for(const key of["instanceId","documentId","versionId"]as const){const ids=value.documents.map(row=>row[key]).filter(id=>id!==null);if(new Set(ids).size!==ids.length)context.addIssue({code:"custom",message:"distinct_original_archived_package_documents_required",path:[key]});}
 if(new Set(value.documents.map(row=>row.locale)).size!==value.documents.length||!value.documents.some(row=>row.locale==="en")||!value.documents.some(row=>row.locale==="fr"))context.addIssue({code:"custom",message:"all_original_package_languages_required"});
 const expected=value.documents.every(row=>row.state==="COMPLETE")?"COMPLETE":value.documents.some(row=>row.state==="SOURCE_CHANGED")?"SOURCE_CHANGED":"PENDING";if(value.state!==expected)context.addIssue({code:"custom",message:"package_completion_requires_every_actual_archived_version"});
});
export const onboardingOwnerPackageRecoverySchema=onboardingOwnerPackageDraftSchema.pick({sessionId:true}).extend({idempotencyKey:id});
export const onboardingOwnerPackageReferenceSchema=z.object({packageId:id}).strict();
