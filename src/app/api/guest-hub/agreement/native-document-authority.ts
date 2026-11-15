import {ZodError} from "zod";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {documentActorContext,documentArchiveContext} from "@/modules/documents/application/document-archive";
import {nativeSignatureDistributionContext} from "@/modules/documents/application/document-signature-distribution-context";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {DocumentAccessError,DocumentConfigurationError,DocumentConflictError,documentSourceReferenceSchema} from "@/modules/documents/domain/document-command";
import {nativeSignatureRecipientPayloadSchema} from "@/modules/documents/domain/document-signature-command";
import {documentGenerationSnapshotSchema} from "@/modules/documents/domain/document-generation";
import {bindGuestHubAgreementOriginal} from "@/modules/guest-hub/domain/guest-hub-agreement-source";
import {GuestHubAgreementAccessError} from "@/modules/guest-hub/domain/guest-hub-agreement-policy";
import type {GuestHubAgreementDocumentAuthorityProvider} from "@/modules/guest-hub/application/guest-hub-agreement-document-authority";

/** Metadata and authority only. Preparing/sending, provider observation and signed
 * archival continue through the canonical document services outside this transaction. */
export const nativeGuestAgreementDocumentAuthority:GuestHubAgreementDocumentAuthorityProvider={
 async capture(actor,tx,source,selection,preparationId,env){
  try{
   const ctx=documentActorContext(actor),target=await nativeSignatureDistributionContext(ctx,tx,preparationId,env),current=target.current,repository=new DocumentRepository(tx,actor.organizationId),instance=current.instance,version=current.version;
   if(current.source.kind!=="RESERVATION"||current.source.id!==source.reservationId||current.archive.native.resource.propertyId!==source.propertyId||!target.policy.value.signing.delivery.emailSettings.recipientSigningRequest)throw new GuestHubAgreementAccessError();
   const generation=documentGenerationSnapshotSchema.parse(instance.sourceSnapshot),variants=generation.variants.map(item=>item.versionId).sort();if(generation.identity.organizationId!==actor.organizationId||generation.identity.documentId!==instance.documentId||generation.identity.instanceId!==instance.id||generation.identity.templateVersionId!==instance.templateVersionId||generation.command.source.kind!=="RESERVATION"||generation.command.source.id!==source.reservationId||JSON.stringify(variants)!==JSON.stringify([...selection.variantVersionIds].sort()))throw new GuestHubAgreementAccessError();
   const guests=target.row.recipients.map(row=>({row,source:nativeSignatureRecipientPayloadSchema.omit({displayName:true,email:true}).parse(row.sourceSnapshot)})).filter(item=>item.source.identity.reference.kind==="GUEST");
   if(guests.length!==1||guests[0].source.identity.reference.id!==source.guestId)throw new GuestHubAgreementAccessError();const guest=guests[0],recipient=target.recipients.find(item=>item.id===guest.row.id);if(!recipient||recipient.layout.role!=="SIGNER")throw new GuestHubAgreementAccessError();
   const templateVersion=await repository.version(instance.templateVersionId),template=templateVersion?await repository.document(templateVersion.documentId):null;if(!templateVersion||!template?.template||template.kind!=="TEMPLATE"||template.archivedAt||templateVersion.id!==selection.templateVersionId)throw new GuestHubAgreementAccessError();
   const templateContext=await documentArchiveContext(ctx,tx,documentSourceReferenceSchema.parse({kind:template.sourceKind,id:template.sourceId}),"export",template,undefined,env);if(templateContext.native.archived||template.typeKey!==instance.document.typeKey||template.locale!==instance.document.locale)throw new GuestHubAgreementAccessError();
   const bound=bindGuestHubAgreementOriginal({protocol:"NATIVE_GUEST_AGREEMENT_ORIGINAL_V1",organizationId:actor.organizationId,reservationId:source.reservationId,propertyId:source.propertyId,guestId:source.guestId,document:{id:instance.documentId,instanceId:instance.id,versionId:version.id,typeKey:instance.document.typeKey,locale:instance.document.locale,sha256:version.admission.sha256,templateKey:template.template.key,templateId:template.id,templateVersionId:templateVersion.id},signature:{id:target.row.id,documentVersionId:target.row.documentVersionId,guestRecipientId:guest.row.id,guestReference:guest.source.identity.reference,guestIdentityFingerprint:guest.source.identity.fingerprint}},{organizationId:actor.organizationId,...source},selection);
   return{original:bound.original,preparationId:target.preparation.id,archivePolicyId:current.archive.policy.id,signaturePolicyId:target.policy.id,templatePolicyId:templateContext.policy.id,fingerprint:jsonbFingerprint({protocol:"NATIVE_GUEST_AGREEMENT_DOCUMENT_AUTHORITY_V1",original:bound.fingerprint,prepared:target.fingerprint,template:templateContext.fingerprint,templateVersion:templateVersion.id,templateSha256:templateVersion.admission.sha256,requestedLocale:selection.requestedLocale,documentLocale:selection.locale})};
  }catch(error){if(error instanceof DocumentAccessError||error instanceof DocumentConfigurationError||error instanceof DocumentConflictError||error instanceof ZodError)throw new GuestHubAgreementAccessError();throw error;}
 }
};
