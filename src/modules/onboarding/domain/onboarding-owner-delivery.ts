import {z} from "zod";
import {ownerPackageDocumentReasonSchema} from "@/platform/documents/owner-package-contract";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
import {onboardingOwnerPackageReceiptSchema} from "./onboarding-owner-package-run";
import {onboardingOwnerDeliveryPolicySchema,type OnboardingOwnerDeliveryPolicy} from "./onboarding-owner-delivery-policy";
import type {OnboardingOwnerPackage} from "./onboarding-owner-package";
import {OnboardingConfigurationError} from "./onboarding-wizard";

const locale=z.enum(["en","fr","ar"]),id=onboardingIdSchema;
export const onboardingOwnerDeliveryProtocol="NATIVE_OWNER_PACKAGE_EMAIL_V1";
export const onboardingOwnerDeliveryRequested="onboarding.owner_package.delivery_requested";
export const onboardingOwnerDeliveryDraftSchema=z.object({packageId:id}).strict();
export const onboardingOwnerDeliveryCommandSchema=onboardingOwnerDeliveryDraftSchema.extend({idempotencyKey:id,reviewFingerprint:onboardingFingerprintSchema,reason:ownerPackageDocumentReasonSchema});
export const onboardingOwnerDeliveryRecoverySchema=onboardingOwnerDeliveryDraftSchema.extend({idempotencyKey:id});
export const onboardingOwnerDeliveryReceiptSchema=z.object({recorded:z.literal(true),id,packageId:id,idempotencyKey:id,requestedAt:z.iso.datetime(),locale:z.enum(["en","fr","ar"]),deliveryRecordId:id.nullable(),state:z.enum(["PENDING","ACCEPTED","DELIVERED","FAILED","BOUNCED","COMPLAINED","SUPPRESSED"]),acceptedAt:z.iso.datetime().nullable(),deliveredAt:z.iso.datetime().nullable(),replayed:z.boolean()}).strict().superRefine((value,context)=>{
 if(["ACCEPTED","DELIVERED"].includes(value.state)&&(!value.deliveryRecordId||!value.acceptedAt)||value.state==="DELIVERED"&&!value.deliveredAt)context.addIssue({code:"custom",message:"actual_canonical_owner_email_acceptance_and_verified_delivery_required"});
});
export const onboardingOwnerDeliverySourceSchema=z.object({
 protocol:z.literal(onboardingOwnerDeliveryProtocol),organizationId:id,packageId:id,sessionId:id,reviewRevisionId:id,ownerId:id,propertyId:id,nativePackageFingerprint:onboardingFingerprintSchema,
 ownerName:z.string().min(1),ownerEmail:z.string().email(),ownerLocale:locale,propertyName:z.string().min(1),policy:onboardingOwnerDeliveryPolicySchema,
 documents:z.array(z.object({locale,instanceId:id,documentId:id,versionId:id}).strict()).min(2).max(3)
}).strict().superRefine((value,context)=>{
 for(const key of["locale","instanceId","documentId","versionId"]as const)if(new Set(value.documents.map(row=>row[key])).size!==value.documents.length)context.addIssue({code:"custom",message:"distinct_actual_completed_package_originals_required",path:["documents",key]});
 const locales=value.documents.map(row=>row.locale);
 if(locales.length!==value.policy.locales.length||!locales.includes("en")||!locales.includes("fr")||!value.policy.locales.every(value=>locales.includes(value))||!locales.includes(value.ownerLocale))context.addIssue({code:"custom",message:"all_original_package_and_owner_email_languages_required"});
});
export type OnboardingOwnerDeliverySource=z.infer<typeof onboardingOwnerDeliverySourceSchema>;

/** Only an authorized native producer supplies the report and receipt; public commands contain references alone. */
export function buildOnboardingOwnerDeliverySource(report:OnboardingOwnerPackage,rawReceipt:unknown,policy:OnboardingOwnerDeliveryPolicy,nativePackageFingerprint:string):OnboardingOwnerDeliverySource{
 const receipt=onboardingOwnerPackageReceiptSchema.parse(rawReceipt),source=report.provenance;
 if(receipt.state!=="COMPLETE"||receipt.reviewRevisionId!==source.revisionId||receipt.sessionId!==source.sessionId||receipt.propertyId!==source.propertyId||report.property.details.id!==source.propertyId||!report.owner.email)throw new OnboardingConfigurationError();
 const prepared=onboardingOwnerDeliverySourceSchema.safeParse({protocol:onboardingOwnerDeliveryProtocol,organizationId:source.organizationId,packageId:receipt.packageId,sessionId:source.sessionId,reviewRevisionId:source.revisionId,ownerId:source.ownerId,propertyId:source.propertyId,nativePackageFingerprint,ownerName:report.owner.displayName,ownerEmail:report.owner.email,ownerLocale:report.owner.preferredLocale,propertyName:report.property.details.name,policy,documents:receipt.documents.map(row=>({locale:row.locale,instanceId:row.instanceId,documentId:row.documentId,versionId:row.versionId}))});
 if(!prepared.success)throw new OnboardingConfigurationError();return prepared.data;
}
