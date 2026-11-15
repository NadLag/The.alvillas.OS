import {ZodError} from "zod";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {readPreparedSignatureAuthority,readPreparedSignatureDeliveryStatus,preparedSignatureCandidatePage} from "@/modules/documents/application/document-prepared-signature-authority";
import {DocumentAccessError,DocumentConfigurationError,DocumentConflictError} from "@/modules/documents/domain/document-command";
import {bindGuestHubAgreementOriginal} from "@/modules/guest-hub/domain/guest-hub-agreement-source";
import {GuestHubAgreementAccessError} from "@/modules/guest-hub/domain/guest-hub-agreement-policy";
import type {GuestHubAgreementDocumentAuthorityProvider} from "@/modules/guest-hub/application/guest-hub-agreement-document-authority";

/** Canonical document/signature authority remains behind its application boundary. */
export const nativeGuestAgreementDocumentAuthority:GuestHubAgreementDocumentAuthorityProvider={
 async choices(actor,tx,source,selection,filter,cursor,env){const page=await preparedSignatureCandidatePage(actor,tx,source.reservationId,filter,cursor),items=[];for(const row of page.items){try{const current=await nativeGuestAgreementDocumentAuthority.capture(actor,tx,source,selection,row.preparationId,env);items.push({...row,original:current.original});}catch(error){if(!(error instanceof GuestHubAgreementAccessError))throw error;}}return{items,next:page.next};},
 async status(actor,tx,original,preparationId,env){const status=await readPreparedSignatureDeliveryStatus(actor,tx,preparationId,env);if(original.organizationId!==actor.organizationId||status.signatureId!==original.signature.id||status.originalVersionId!==original.document.versionId)throw new GuestHubAgreementAccessError();return status;},
 async capture(actor,tx,source,selection,preparationId,env){try{
  const target=await readPreparedSignatureAuthority(actor,tx,preparationId,env),guests=target.signature.recipients.filter(item=>item.reference.kind==="GUEST");
  if(target.source.kind!=="RESERVATION"||target.source.id!==source.reservationId||target.propertyId!==source.propertyId||!target.emailSigningRequestEnabled||guests.length!==1||guests[0].reference.id!==source.guestId||guests[0].role!=="SIGNER"||JSON.stringify([...target.variantVersionIds].sort())!==JSON.stringify([...selection.variantVersionIds].sort()))throw new GuestHubAgreementAccessError();
  const guest=guests[0],bound=bindGuestHubAgreementOriginal({protocol:"NATIVE_GUEST_AGREEMENT_ORIGINAL_V1",organizationId:target.organizationId,reservationId:source.reservationId,propertyId:source.propertyId,guestId:source.guestId,document:target.document,signature:{id:target.signature.id,documentVersionId:target.signature.documentVersionId,guestRecipientId:guest.id,guestReference:guest.reference,guestIdentityFingerprint:guest.fingerprint}},{organizationId:actor.organizationId,...source},selection);
  return{original:bound.original,preparationId:target.preparationId,archivePolicyId:target.archivePolicyId,signaturePolicyId:target.signaturePolicyId,templatePolicyId:target.templatePolicyId,fingerprint:jsonbFingerprint({protocol:"NATIVE_GUEST_AGREEMENT_DOCUMENT_AUTHORITY_V1",original:bound.fingerprint,documentAuthority:target.fingerprint,selection})};
 }catch(error){if(error instanceof DocumentAccessError||error instanceof DocumentConfigurationError||error instanceof DocumentConflictError||error instanceof ZodError)throw new GuestHubAgreementAccessError();throw error;}}
};
