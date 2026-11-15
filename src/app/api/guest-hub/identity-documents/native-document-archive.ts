import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {DocumentAdmission} from "@prisma/client";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {readNativeGuestIdentityAdmission,admitNativeGuestIdentityDocumentUpload,uploadDocumentBytes,uploadDocumentPart,completeDocumentParts,type DocumentActorContext} from "@/modules/documents/application/document-archive";
import {reserveNativeGuestIdentityRetention,publishNativeGuestIdentityRetention} from "@/modules/documents/application/document-retention-service";
import type {NativeGuestIdentityArchiveBoundary} from "@/modules/documents/application/document-guest-identity-boundary";
import type {DocumentObjectStore} from "@/modules/documents/application/document-files";
import {documentUploadReviewInput,DocumentAccessError,DocumentConflictError} from "@/modules/documents/domain/document-command";
import {nativeGuestIdentityDocumentProtocol,nativeGuestIdentityDocumentUploadInput,nativeGuestIdentityDocumentFileName,nativeGuestIdentityDocumentProvenanceSchema} from "@/modules/documents/domain/document-guest-identity-upload";
import {createGuestHubIdentityArchive} from "@/modules/guest-hub/application/guest-hub-identity-archive";
import type {GuestHubIdentityUploadRequest,GuestHubIdentityFileStatusRequest} from "@/modules/guest-hub/application/guest-hub-identity-upload-request";
import type {GuestHubVisitDependencies} from "@/modules/guest-hub/application/guest-hub-visit";

type Request=GuestHubIdentityUploadRequest|GuestHubIdentityFileStatusRequest;
type File=Parameters<Parameters<Request["run"]>[1]>[0];
type Dependencies=GuestHubVisitDependencies&{objects?:DocumentObjectStore};
function inputFor(file:File,documentId:string){
 const locale=z.enum(["en","fr","ar"]).parse(file.source.locale),type=file.archivePolicy.value.types.find(type=>type.key===file.policy.documentTypeKey);if(!type)throw new DocumentAccessError();
 return nativeGuestIdentityDocumentUploadInput.parse({documentId,source:{kind:"RESERVATION",id:file.capture.reservationId},typeKey:file.policy.documentTypeKey,kind:"FILE",locale,title:type.labels[locale],fileName:nativeGuestIdentityDocumentFileName(file.file.id,file.descriptor.contentType),contentType:file.descriptor.contentType,fileSize:file.descriptor.fileSize,sha256:file.descriptor.sha256,...file.descriptor.parts?{parts:file.descriptor.parts}:{},supersedesId:null,effectiveFrom:null,templateKey:null,idempotencyKey:file.file.id,reviewFingerprint:"0".repeat(64),reason:type.labels[locale]+" · "+file.file.id,guestIdentity:{protocol:nativeGuestIdentityDocumentProtocol,captureId:file.capture.id,fileId:file.file.id}});
}
function draftFor(input:ReturnType<typeof inputFor>){return documentUploadReviewInput.parse(Object.fromEntries(Object.entries(input).filter(([key])=>!["idempotencyKey","reviewFingerprint","reason","guestIdentity"].includes(key))));}
function samePrincipal(actor:DocumentActorContext,file:File){if(actor.organizationId!==file.capture.organizationId||actor.actorId!==file.documentActor.actorId||commandFingerprint(captureAuthorizationCap(actor.authContext))!==commandFingerprint(captureAuthorizationCap(file.documentActor.authContext)))throw new DocumentAccessError();}

/** Composition owns both modules' private contracts. Every storage operation uses
 * the canonical archive with separate, short native transactions around I/O. */
export async function createNativeGuestIdentityFileArchive(request:Request,deps:Dependencies){
 const requestId=deps.requestId??randomUUID(),organizationId=request.organizationId,native=createGuestHubIdentityArchive(request,requestId);
 const initial=await withTenant(deps.db,organizationId,tx=>native.run(tx,async(file,bridge)=>{
   const documentId=bridge?.documentId??randomUUID(),original=bridge?await readNativeGuestIdentityAdmission(file.documentActor,tx,{admissionId:bridge.admissionId,documentId:bridge.documentId,captureId:file.capture.id,fileId:file.file.id},deps.env):null;
   return{actor:file.documentActor,documentId,privacy:file.policy.privacy,input:original?nativeGuestIdentityDocumentUploadInput.parse(original.input):inputFor(file,documentId),provenance:nativeGuestIdentityDocumentProvenanceSchema.parse({protocol:nativeGuestIdentityDocumentProtocol,origin:"GUEST_CAPABILITY",organizationId,linkId:request.linkId,grantId:file.grant.id,captureId:file.capture.id,fileId:file.file.id,delegatedBy:file.documentActor.actorId})};
 }));
 async function validate(actor:DocumentActorContext,tx:TenantTransaction,row:DocumentAdmission){return native.run(tx,(file,bridge)=>{
  samePrincipal(actor,file);const input=nativeGuestIdentityDocumentUploadInput.parse(row.input);
  if(!bridge||bridge.documentId!==initial.documentId||bridge.admissionId!==row.id||row.documentId!==initial.documentId||row.createdBy!==actor.actorId||commandFingerprint(row.authorizationCap)!==commandFingerprint(file.grant.authorizationCap)||input.guestIdentity.captureId!==file.capture.id||input.guestIdentity.fileId!==file.file.id||input.source.id!==file.capture.reservationId||input.typeKey!==file.policy.documentTypeKey||input.contentType!==file.descriptor.contentType||input.fileSize!==file.descriptor.fileSize||input.sha256!==file.descriptor.sha256||commandFingerprint(input.parts??null)!==commandFingerprint(file.descriptor.parts??null))throw new DocumentAccessError();
  return Promise.resolve({file,bridge});
 });}
 const boundary:NativeGuestIdentityArchiveBoundary={access:request.access,documentId:initial.documentId,privacy:initial.privacy,provenance:initial.provenance,
  async prepareAdmission(actor,tx,raw){if(request.access!=="UPLOAD")throw new DocumentAccessError();await request.run(tx,file=>{samePrincipal(actor,file);if(commandFingerprint(documentUploadReviewInput.parse(raw))!==commandFingerprint(draftFor(inputFor(file,initial.documentId)))||commandFingerprint(initial.privacy)!==commandFingerprint(file.policy.privacy))throw new DocumentConflictError();return Promise.resolve();});},
  async recordAdmission(actor,tx,row){if(row.documentId!==initial.documentId)throw new DocumentAccessError();await native.recordAdmission(actor,tx,row);},
  async assertAdmission(actor,tx,row){const {bridge}=await validate(actor,tx,row);if(bridge.publication)await native.verifyPublication(tx);},
  async reserveRetention(actor,tx,row){if(request.access!=="UPLOAD")throw new DocumentAccessError();return request.run(tx,async file=>{
   await validate(actor,tx,row);return reserveNativeGuestIdentityRetention(actor,tx,row,{origin:initial.provenance,policy:{id:file.retentionPolicy.id,version:file.retentionPolicy.version,value:file.retentionPolicy.value},tagKeys:file.policy.retentionTagKeys},{...deps,requestId});
  });},
  async publishVersion(actor,tx,row,version,reservation){if(request.access!=="UPLOAD")throw new DocumentAccessError();await validate(actor,tx,row);const retention=await publishNativeGuestIdentityRetention(actor,tx,row,version.id,reservation,{...deps,requestId});await native.recordPublication(actor,tx,row,version,retention);}
 };
 const archiveDeps={...deps,requestId,nativeGuestIdentity:boundary};
 function status(){return withTenant(deps.db,organizationId,tx=>native.status(tx));}
 async function admitted(){if(request.access!=="UPLOAD")throw new DocumentAccessError();return admitNativeGuestIdentityDocumentUpload(initial.actor,initial.input,archiveDeps);}
 return Object.freeze({status,
  async admit(){await admitted();return status();},
  async upload(bytes:Uint8Array){const admission=await admitted();await uploadDocumentBytes(initial.actor,{admissionId:admission.id},bytes,archiveDeps);return status();},
  async part(index:number,bytes:Uint8Array){const admission=await admitted();await uploadDocumentPart(initial.actor,{admissionId:admission.id,index},bytes,archiveDeps);return status();},
  async complete(){const admission=await admitted();await completeDocumentParts(initial.actor,{admissionId:admission.id},archiveDeps);return status();}
 });
}
