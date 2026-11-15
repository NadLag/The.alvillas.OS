import type {TenantTransaction} from "@/platform/db/tenant";
import type {Prisma} from "@prisma/client";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {GuestHubIdentityArchiveRepository} from "../infrastructure/guest-hub-identity-archive-repository";
import {GuestHubIdentityDocumentAccessError} from "../domain/guest-hub-identity-document-policy";
import {guestHubIdentityFileStatusSchema} from "../domain/guest-hub-identity-file-read-model";
import type {GuestHubIdentityUploadRequest,GuestHubIdentityFileStatusRequest} from "./guest-hub-identity-upload-request";

type Request=GuestHubIdentityUploadRequest|GuestHubIdentityFileStatusRequest;
type File=Parameters<Parameters<Request["run"]>[1]>[0];
type Admission={id:string;documentId:string;commandKey:string;createdBy:string;createdAt:Date};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function principal(actor:AccountActorContext,file:File){if(actor.organizationId!==file.capture.organizationId||actor.actorId!==file.documentActor.actorId||commandFingerprint(captureAuthorizationCap(actor.authContext))!==commandFingerprint(captureAuthorizationCap(file.documentActor.authContext)))throw new GuestHubIdentityDocumentAccessError();}

/** The application owns native persistence and audit. Composition receives only
 * the exact leased file and immutable bridge facts, never a raw repository. */
export function createGuestHubIdentityArchive(request:Request,requestId:string){
 const organizationId=request.organizationId,repository=(tx:TenantTransaction)=>new GuestHubIdentityArchiveRepository(tx,organizationId);
 return{
  run<T>(tx:TenantTransaction,work:(file:File,admission:Awaited<ReturnType<GuestHubIdentityArchiveRepository["admission"]>>)=>Promise<T>){return request.run(tx,async file=>work(file,await repository(tx).admission(file.file.id)));},
  async recordAdmission(actor:AccountActorContext,tx:TenantTransaction,row:Admission){if(request.access!=="UPLOAD")throw new GuestHubIdentityDocumentAccessError();await request.run(tx,async file=>{
   principal(actor,file);if(row.commandKey!==file.file.id||row.createdBy!==actor.actorId)throw new GuestHubIdentityDocumentAccessError();
   const payload={captureId:file.capture.id,fileId:file.file.id,documentId:row.documentId,admissionId:row.id},event=await new OutboxRepository(tx,organizationId).append("guest_hub.identity_document_admitted",payload,"guest-hub-identity-document-admission:"+file.file.id,row.createdAt);
   await repository(tx).appendAdmission({fileId:file.file.id,documentId:row.documentId,admissionId:row.id,retentionPolicyId:file.retentionPolicy.id,retentionPolicyVersion:file.retentionPolicy.version,retentionPolicySnapshot:json(file.retentionPolicy),tagKeys:[...file.policy.retentionTagKeys].sort(),tags:json([...file.policy.retentionTags].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)),outboxEventId:event.id,createdAt:row.createdAt,requestId});
   await writeAuditEvent(tx,{organizationId,actorId:null,action:"guest_hub.identity_document_admitted",resourceType:"guest_hub_identity_documents",resourceId:file.file.id,propertyScopeId:file.capture.propertyId,after:{...payload,linkId:request.linkId,grantId:file.grant.id,outboxEventId:event.id},requestId,occurredAt:row.createdAt});await repository(tx).validateAdmissionBirth();
  });},
  async recordPublication(actor:AccountActorContext,tx:TenantTransaction,row:Admission,version:{id:string;createdAt:Date},retention:{id:string}){if(request.access!=="UPLOAD")throw new GuestHubIdentityDocumentAccessError();await request.run(tx,async file=>{
   principal(actor,file);const original=await repository(tx).admission(file.file.id);if(!original||original.documentId!==row.documentId||original.admissionId!==row.id||row.createdBy!==actor.actorId)throw new GuestHubIdentityDocumentAccessError();
   const payload={captureId:file.capture.id,fileId:file.file.id,documentId:row.documentId,admissionId:row.id,versionId:version.id,retentionRevisionId:retention.id},event=await new OutboxRepository(tx,organizationId).append("guest_hub.identity_document_published",payload,"guest-hub-identity-document-publication:"+file.file.id,version.createdAt);
   await repository(tx).appendPublication({fileId:file.file.id,versionId:version.id,retentionRevisionId:retention.id,outboxEventId:event.id,createdAt:version.createdAt,requestId});
   await writeAuditEvent(tx,{organizationId,actorId:null,action:"guest_hub.identity_document_published",resourceType:"guest_hub_identity_documents",resourceId:file.file.id,propertyScopeId:file.capture.propertyId,after:{...payload,linkId:request.linkId,grantId:file.grant.id,outboxEventId:event.id},requestId,occurredAt:version.createdAt});
  });},
  verifyPublication(tx:TenantTransaction){return request.run(tx,async file=>{if(await repository(tx).publication(file.file.id))await repository(tx).validatePublicationBirth();});},
  status(tx:TenantTransaction){return request.run(tx,async file=>{
   const bridge=await repository(tx).admission(file.file.id),publication=bridge?.publication,data={captureId:file.capture.id,fileId:file.file.id,kind:file.file.kind,part:file.file.part,state:publication?"PUBLISHED":bridge?"ADMITTED":"PENDING",currentCapture:file.currentCapture,publishedAt:publication?.createdAt.toISOString()??null};
   await writeAuditEvent(tx,{organizationId,actorId:null,action:"guest_hub.identity_document_status_read",resourceType:"guest_hub_identity_documents",resourceId:file.file.id,propertyScopeId:file.capture.propertyId,after:{captureId:file.capture.id,fileId:file.file.id,state:data.state},requestId,occurredAt:file.now});
   return guestHubIdentityFileStatusSchema.parse(present({...file.formAuthority,visibleDataClasses:new Set()},"view",{...file.formResource,data},catalogFieldPolicy("guest_hub_identity_documents"),file.now));
  });}
 };
}
