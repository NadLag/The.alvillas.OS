import type {TenantTransaction} from "@/platform/db/tenant";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {DocumentRepository} from "../infrastructure/document-repository";
import {DocumentAccessError,DocumentConflictError,documentSourceReferenceSchema} from "../domain/document-command";
import {documentGenerationSnapshotSchema} from "../domain/document-generation";
import {nativeSignatureRecipientPayloadSchema} from "../domain/document-signature-command";
import {documentActorContext,documentArchiveContext,type DocumentActorContext} from "./document-archive";
import {nativeSignatureDistributionContext} from "./document-signature-distribution-context";
import {retainedNativeSignatureReadContext,retainedNativeSignatureSummary} from "./document-signature-history";
import {retainedSignedArchiveReceipt} from "./document-signed-archive-reconciliation";
import {SignaturePreparationRepository} from "../infrastructure/signature-preparation-repository";
import {documentReadCursor,readDocumentCursor} from "./document-workspace";

/** Authorized original metadata without private recipient contact values,
 * provider calls or a second document/source authority. */
export async function readPreparedSignatureAuthority(actor:DocumentActorContext,tx:TenantTransaction,preparationId:string,env?:NodeJS.ProcessEnv){
 const ctx=documentActorContext(actor),target=await nativeSignatureDistributionContext(ctx,tx,preparationId,env),current=target.current,repository=new DocumentRepository(tx,ctx.organizationId),instance=current.instance,version=current.version,generation=documentGenerationSnapshotSchema.parse(instance.sourceSnapshot);
 if(generation.identity.organizationId!==ctx.organizationId||generation.identity.documentId!==instance.documentId||generation.identity.instanceId!==instance.id||generation.identity.templateVersionId!==instance.templateVersionId||generation.command.source.kind!==current.source.kind||generation.command.source.id!==current.source.id)throw new DocumentConflictError();
 const templateVersion=await repository.version(instance.templateVersionId),template=templateVersion?await repository.document(templateVersion.documentId):null;if(!templateVersion||!template?.template||template.kind!=="TEMPLATE"||template.archivedAt)throw new DocumentAccessError();
 const templateContext=await documentArchiveContext(ctx,tx,documentSourceReferenceSchema.parse({kind:template.sourceKind,id:template.sourceId}),"export",template,undefined,env);if(templateContext.native.archived||template.typeKey!==instance.document.typeKey||template.locale!==instance.document.locale)throw new DocumentConflictError();
 const recipients=target.row.recipients.map(row=>{const retained=nativeSignatureRecipientPayloadSchema.omit({displayName:true,email:true}).parse(row.sourceSnapshot),actual=target.recipients.find(item=>item.id===row.id);if(!actual||retained.identity.organizationId!==ctx.organizationId||retained.identity.signatureId!==target.row.id||retained.identity.recipientId!==row.id||retained.identity.fingerprint!==actual.fingerprint)throw new DocumentConflictError();return{id:row.id,reference:retained.identity.reference,fingerprint:retained.identity.fingerprint,role:actual.layout.role};});
 return{organizationId:ctx.organizationId,preparationId:target.preparation.id,source:current.source,propertyId:current.archive.native.resource.propertyId??null,
  document:{id:instance.documentId,instanceId:instance.id,versionId:version.id,typeKey:instance.document.typeKey,locale:instance.document.locale,sha256:version.admission.sha256,templateKey:template.template.key,templateId:template.id,templateVersionId:templateVersion.id},
  signature:{id:target.row.id,documentVersionId:target.row.documentVersionId,recipients},variantVersionIds:generation.variants.map(item=>item.versionId),emailSigningRequestEnabled:target.policy.value.signing.delivery.emailSettings.recipientSigningRequest,
  archivePolicyId:current.archive.policy.id,signaturePolicyId:target.policy.id,templatePolicyId:templateContext.policy.id,fingerprint:commandFingerprint({protocol:"NATIVE_PREPARED_SIGNATURE_DOCUMENT_AUTHORITY_V1",prepared:target.fingerprint,template:templateContext.fingerprint,templateVersionId:templateVersion.id,templateSha256:templateVersion.admission.sha256})};
}
/** Completion comes only from native signature history and the existing sealed
 * signed-PDF/certificate archive. Email delivery is a separate observation. */
export async function readPreparedSignatureDeliveryStatus(actor:DocumentActorContext,tx:TenantTransaction,preparationId:string,env?:NodeJS.ProcessEnv){
 const ctx=documentActorContext(actor),prepared=await readPreparedSignatureAuthority(ctx,tx,preparationId,env),current=await retainedNativeSignatureReadContext(ctx,tx,prepared.signature.id,{env}),summary=await retainedNativeSignatureSummary(current),archive=await retainedSignedArchiveReceipt(ctx,tx,prepared.signature.id,env),attempt=await new SignaturePreparationRepository(tx,ctx.organizationId).distributionAttempt(prepared.signature.id);
 if(summary.documentVersionId!==prepared.document.versionId||archive.signatureId!==summary.id)throw new DocumentConflictError();
 return{signatureId:summary.id,originalVersionId:summary.documentVersionId,signatureState:summary.state,archiveState:archive.state,signedVersionId:archive.signedVersionId,certificateVersionId:archive.certificateVersionId,distributionState:attempt?attempt.evidence.some(row=>row.kind==="SENT")?"SENT" as const:"UNCERTAIN" as const:null};
}
/** Only opaque native candidate identities cross to composition. Each original
 * must pass its independent document/template/signature authority before display. */
export async function preparedSignatureCandidatePage(actor:DocumentActorContext,tx:TenantTransaction,reservationId:string,filter:string,cursor?:string){
 const ctx=documentActorContext(actor),before=readDocumentCursor(ctx,filter,cursor),rows=await new SignaturePreparationRepository(tx,ctx.organizationId).preparedForReservation(reservationId,before),page=rows.slice(0,25),last=page.at(-1);
 return{items:page.map(row=>({preparationId:row.id,preparedAt:row.requestedAt.toISOString()})),next:rows.length>25&&last?documentReadCursor(ctx,filter,last.id):null};
}
export async function retainedSignatureOriginalAuthority(actor:DocumentActorContext,tx:TenantTransaction,signatureId:string,env?:NodeJS.ProcessEnv){
 const current=await retainedNativeSignatureReadContext(documentActorContext(actor),tx,signatureId,{env});return{signatureId:current.row.id,documentId:current.current.instance.documentId,instanceId:current.row.instanceId,versionId:current.row.documentVersionId,sha256:current.current.version.admission.sha256,guestIds:current.recipients.filter(row=>row.reference.kind==="GUEST").map(row=>row.reference.id)};
}
