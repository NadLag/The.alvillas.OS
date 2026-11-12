import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
import {authorizationCapSchema} from "@/platform/authz/authorization-cap";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {recipientKey} from "@/platform/notifications/email-recipient";
import {onboardingIdSchema,onboardingFingerprintSchema} from "./onboarding-primitives";
import {onboardingOwnerDeliveryCommandSchema,onboardingOwnerDeliverySourceSchema,onboardingOwnerDeliveryProtocol} from "./onboarding-owner-delivery";
import {onboardingOwnerDeliveryPolicySchema} from "./onboarding-owner-delivery-policy";

const id=onboardingIdSchema,sha=onboardingFingerprintSchema,locale=z.enum(["en","fr","ar"]);
/** Public database metadata contains no recipient address, report bodies or email text. */
export const onboardingOwnerDeliveryMetadataSchema=z.object({
 protocol:z.literal(onboardingOwnerDeliveryProtocol),organizationId:id,packageId:id,sessionId:id,reviewRevisionId:id,ownerId:id,propertyId:id,
 nativePackageFingerprint:sha,ownerVersion:z.string().regex(/^\d+$/u),ownerTuple:z.string().regex(/^\(\d+,\d+\)$/u),ownerCreatedAt:z.iso.datetime(),ownerUpdatedAt:z.iso.datetime(),
 recipientKey:sha,ownerLocale:locale,emailFingerprint:sha
}).strict();
export const onboardingOwnerDeliveryDocumentSchema=z.object({locale,instanceId:id,documentId:id,versionId:id,sha256:sha,cipherSha256:sha,byteSize:z.number().int().positive(),contentType:z.literal("application/pdf")}).strict();
export const onboardingOwnerDeliveryDocumentPlanSchema=z.array(onboardingOwnerDeliveryDocumentSchema).min(2).max(3).superRefine((rows,context)=>{
 for(const key of["locale","instanceId","documentId","versionId"]as const)if(new Set(rows.map(row=>row[key])).size!==rows.length)context.addIssue({code:"custom",message:"distinct_original_email_attachment_versions_required",path:[key]});
 if(!rows.some(row=>row.locale==="en")||!rows.some(row=>row.locale==="fr"))context.addIssue({code:"custom",message:"both_original_email_attachment_languages_required"});
});
export const onboardingOwnerDeliveryEmailSchema=z.object({to:z.string().email(),subject:z.string().min(1).regex(/^[^\r\n\u2028\u2029]+$/u),html:z.string().min(1),text:z.string().min(1),locale,template:z.literal("onboarding.owner_package")}).strict();
export const onboardingOwnerDeliveryPolicySnapshotSchema=z.object({id,version:z.number().int().positive(),value:onboardingOwnerDeliveryPolicySchema}).strict();
export const onboardingOwnerDeliveryOriginalSchema=z.object({
 protocol:z.literal(onboardingOwnerDeliveryProtocol),command:onboardingOwnerDeliveryCommandSchema,source:onboardingOwnerDeliverySourceSchema,metadata:onboardingOwnerDeliveryMetadataSchema,
 documentPlan:onboardingOwnerDeliveryDocumentPlanSchema,emails:z.array(onboardingOwnerDeliveryEmailSchema).min(2).max(3),policySnapshot:onboardingOwnerDeliveryPolicySnapshotSchema,authorizationCap:authorizationCapSchema
}).strict().superRefine((value,context)=>{
 const source=value.source,metadata=value.metadata,invalid=(message:string)=>context.addIssue({code:"custom",message});
 for(const key of["organizationId","packageId","sessionId","reviewRevisionId","ownerId","propertyId","nativePackageFingerprint","ownerLocale"]as const)if(source[key]!==metadata[key])invalid("original_owner_email_source_identity_required");
 if(value.command.packageId!==source.packageId||value.authorizationCap.organizationId!==source.organizationId||metadata.recipientKey!==recipientKey(source.organizationId,source.ownerEmail)||!isDeepStrictEqual(value.policySnapshot.value,source.policy))invalid("original_owner_email_recipient_policy_and_tenant_required");
 if(value.documentPlan.length!==source.documents.length||value.documentPlan.some(row=>!source.documents.some(original=>original.locale===row.locale&&original.instanceId===row.instanceId&&original.documentId===row.documentId&&original.versionId===row.versionId)))invalid("actual_original_owner_package_attachment_versions_required");
 if(value.emails.length!==source.policy.locales.length||new Set(value.emails.map(row=>row.locale)).size!==value.emails.length||value.emails.some(row=>row.to!==source.ownerEmail||!source.policy.locales.includes(row.locale))||!value.emails.some(row=>row.locale===source.ownerLocale))invalid("all_original_owner_email_languages_and_recipient_required");
 if(metadata.emailFingerprint!==jsonbFingerprint({source,variants:value.emails}))invalid("original_owner_email_body_fingerprint_required");
});
export type OnboardingOwnerDeliveryOriginal=z.infer<typeof onboardingOwnerDeliveryOriginalSchema>;
