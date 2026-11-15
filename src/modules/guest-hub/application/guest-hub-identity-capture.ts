import {createHash,randomUUID} from "node:crypto";
import {ZodError} from "zod";
import type {GuestHubIdentityDocumentCapture} from "@prisma/client";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubIdentityDocumentReviewInputSchema,guestHubIdentityDocumentSubmitSchema,guestHubIdentityDocumentRecoverySchema,validateGuestHubIdentityDocumentSelection} from "../domain/guest-hub-identity-document-contract";
import {guestHubIdentityDocumentReviewBindingSchema,guestHubStoredIdentityDocumentReview,type GuestHubIdentityDocumentPayloadBinding} from "../domain/guest-hub-identity-document-private-contract";
import {signGuestHubIdentityDocumentReview,verifyGuestHubIdentityDocumentReview,signGuestHubIdentityDocumentCommand,verifyGuestHubIdentityDocumentCommand,encryptGuestHubIdentityDocumentCapture,decryptGuestHubIdentityDocumentCapture} from "../domain/guest-hub-identity-document-private";
import {guestHubIdentityCaptureViewSchema,guestHubIdentityCaptureReviewSchema,guestHubIdentityCaptureReceiptSchema} from "../domain/guest-hub-identity-capture-read-model";
import {GuestHubIdentityDocumentAccessError,GuestHubIdentityDocumentConflictError} from "../domain/guest-hub-identity-document-policy";
import {GuestHubIdentityCaptureRepository} from "../infrastructure/guest-hub-identity-capture-repository";
import {activeGuestHubIdentityDocuments} from "./guest-hub-identity-document-source";
import {guestHubIdentityCaptureBinding} from "./guest-hub-identity-capture-source";
import type {GuestHubIdentityDocumentAuthorityProvider} from "./guest-hub-identity-document-grants";
import {withGuestHubForm,type GuestHubFormContext} from "./guest-hub-form-visit";
import type {GuestHubVisitDependencies} from "./guest-hub-visit";

type Context=GuestHubFormContext<Awaited<ReturnType<typeof activeGuestHubIdentityDocuments>>>;
type ReviewInput=ReturnType<typeof guestHubIdentityDocumentReviewInputSchema.parse>;
const repository=(context:Context)=>new GuestHubIdentityCaptureRepository(context.tx,context.actual.row.organizationId);
function reviewBinding(context:Context,input:ReviewInput){
 const {row}=context.actual,form=context.form;
 validateGuestHubIdentityDocumentSelection({previousCaptureId:input.previousCaptureId,files:input.files,acknowledged:input.acknowledged},form.policy);
 return guestHubIdentityDocumentReviewBindingSchema.parse({...input,protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_REVIEW_V1",organizationId:row.organizationId,linkId:row.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,grantId:form.grant.id,grantFingerprint:form.grantFingerprint,formFingerprint:form.fingerprint,policyFingerprint:form.settings.fingerprint,sourceFingerprint:form.sourceFingerprint});
}
function publish(context:Context,data:Record<string,unknown>){return present({...context.formAuthority,visibleDataClasses:new Set()},"view",{...context.formResource,data},catalogFieldPolicy("guest_hub_identity_documents"),context.form.now);}
function receipt(context:Context,row:GuestHubIdentityDocumentCapture,replayed:boolean){return guestHubIdentityCaptureReceiptSchema.parse(publish(context,{id:row.id,linkId:row.linkId,reservationId:row.reservationId,grantId:row.grantId,version:row.version,idempotencyKey:row.commandKey,createdAt:row.createdAt.toISOString(),files:row.fileManifest,replayed}));}
async function readAudit(context:Context,action:string,deps:GuestHubVisitDependencies,captureId?:string){const {row}=context.actual;await writeAuditEvent(context.tx,{organizationId:row.organizationId,actorId:null,action,resourceType:"guest_hub_identity_documents",resourceId:captureId??row.id,propertyScopeId:row.propertyId,after:{linkId:row.id,reservationId:row.reservationId,...captureId?{captureId}:{}},requestId:deps.requestId??randomUUID(),occurredAt:await context.actual.repository.clock()});}

/** Concrete document authority is mandatory; the original budgeted capability boundary remains shared. */
export function createGuestHubIdentityCaptureService(documents:GuestHubIdentityDocumentAuthorityProvider){
 function visit<T>(capability:unknown,deps:GuestHubVisitDependencies,work:(context:Context)=>Promise<T>,submission=false){return withGuestHubForm(capability,deps,{
  resourceType:"guest_hub_identity_documents",rateKey:"guest-hub:identity-capture-submit:",
  active:(context,env)=>activeGuestHubIdentityDocuments(context,documents,env),
  lock:context=>new GuestHubIdentityCaptureRepository(context.tx,context.actual.row.organizationId).lockCaptures(context.actual.row.reservationId,context.actual.row.guestId),
  AccessError:GuestHubIdentityDocumentAccessError,isValidation:error=>error instanceof ZodError
 },work,submission);}
 return{
  async view(capability:unknown,deps:GuestHubVisitDependencies){return visit(capability,deps,async context=>{
   const {row}=context.actual,latest=await repository(context).latestCapture(row.reservationId,row.guestId),policy=context.form.policy;
   const data={linkId:row.id,reservationId:row.reservationId,grantId:context.form.grant.id,previousCaptureId:latest?.id??null,captureCount:latest?.version??0,maxCaptures:policy.maxCaptures,...latest?.linkId===row.id&&latest.grantId===context.form.grant.id?{originalCapture:{id:latest.id,files:latest.fileManifest}}:{},notice:policy.notice,requireAcknowledgement:policy.requireAcknowledgement,requiredKinds:policy.requiredKinds,documentKinds:policy.documents.map(document=>({kind:document.kind,allowedParts:document.allowedParts,requiredParts:document.requiredParts,contentTypes:document.contentTypes,maxBytes:document.maxBytes}))};
   await readAudit(context,"guest_hub.identity_capture_opened",deps);return guestHubIdentityCaptureViewSchema.parse(publish(context,data));
  });},
  async review(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies){const input=guestHubIdentityDocumentReviewInputSchema.parse(raw);return visit(capability,deps,async context=>{
   const {row}=context.actual,latest=await repository(context).latestCapture(row.reservationId,row.guestId);
   if(input.previousCaptureId!==(latest?.id??null)||(latest?.version??0)>=context.form.policy.maxCaptures)throw new GuestHubIdentityDocumentConflictError();
   const binding=reviewBinding(context,input);await readAudit(context,"guest_hub.identity_capture_reviewed",deps);
   return guestHubIdentityCaptureReviewSchema.parse(publish(context,{...input,grantId:context.form.grant.id,reviewFingerprint:signGuestHubIdentityDocumentReview(binding,deps.env)}));
  },true);},
  async record(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies){const input=guestHubIdentityDocumentSubmitSchema.parse(raw);return visit(capability,deps,async context=>{
   const {row}=context.actual,form=context.form,repo=repository(context),original=await repo.captureByNonce(row.id,input.idempotencyKey);
   if(original){
    const binding=guestHubIdentityCaptureBinding(original),payload=decryptGuestHubIdentityDocumentCapture(original.encryptedPayload,binding,original.fileManifest,deps.env),review={...guestHubStoredIdentityDocumentReview(binding,payload),files:input.files,previousCaptureId:input.previousCaptureId,acknowledged:input.acknowledged};
    if(original.grantId!==form.grant.id||!verifyGuestHubIdentityDocumentCommand(review,input.reviewFingerprint,original.commandKeyVersion,original.commandHash,deps.env))throw new GuestHubIdentityDocumentConflictError();
    await readAudit(context,"guest_hub.identity_capture_recovered",deps,original.id);return receipt(context,original,true);
   }
   const latest=await repo.latestCapture(row.reservationId,row.guestId);if(input.previousCaptureId!==(latest?.id??null)||(latest?.version??0)>=form.policy.maxCaptures)throw new GuestHubIdentityDocumentConflictError();
   const review=reviewBinding(context,{previousCaptureId:input.previousCaptureId,idempotencyKey:input.idempotencyKey,files:input.files,acknowledged:input.acknowledged});verifyGuestHubIdentityDocumentReview(review,input.reviewFingerprint,deps.env);
   await context.actual.repository.lockPolicy(form.settings.rule.id);
   const id=randomUUID(),createdAt=await context.actual.repository.clock(),requestId=deps.requestId??randomUUID(),command=signGuestHubIdentityDocumentCommand(review,input.reviewFingerprint,deps.env),manifest=review.files.map(file=>({id:randomUUID(),kind:file.kind,part:file.part}));
   const binding:GuestHubIdentityDocumentPayloadBinding={protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_CAPTURE_V1",id,organizationId:row.organizationId,linkId:row.id,grantId:form.grant.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:latest?.id??null,version:(latest?.version??0)+1,commandKey:input.idempotencyKey,commandHash:command.commandHash,commandKeyVersion:command.keyVersion,grantFingerprint:form.grantFingerprint,formFingerprint:form.fingerprint,manifestFingerprint:jsonbFingerprint(manifest),policyId:form.settings.rule.id,policyVersion:form.settings.rule.version,policyFingerprint:form.settings.fingerprint,sourceFingerprint:form.sourceFingerprint,createdAt:createdAt.toISOString()};
   const encryptedPayload=encryptGuestHubIdentityDocumentCapture({schemaVersion:1,files:review.files,acknowledged:review.acknowledged,reviewFingerprint:input.reviewFingerprint},binding,manifest,deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex"),event=await new OutboxRepository(context.tx,row.organizationId).append("guest_hub.identity_capture_recorded",{captureId:id,linkId:row.id,reservationId:row.reservationId},"guest-hub-identity-capture:"+row.id+":"+input.idempotencyKey,createdAt);
   const saved=await repo.createCapture({id,linkId:row.id,grantId:form.grant.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:binding.previousId,version:binding.version,commandKey:input.idempotencyKey,commandHash:command.commandHash,commandKeyVersion:command.keyVersion,grantFingerprint:form.grantFingerprint,formFingerprint:form.fingerprint,manifestFingerprint:binding.manifestFingerprint,fileManifest:manifest,policyId:form.settings.rule.id,policyVersion:form.settings.rule.version,policyFingerprint:form.settings.fingerprint,policySnapshot:form.settings.snapshot,sourceFingerprint:form.sourceFingerprint,sourceSnapshot:form.sourceSnapshot,encryptedPayload,payloadSha256,payloadSchema:1,outboxEventId:event.id,createdAt,requestId});
   await writeAuditEvent(context.tx,{organizationId:row.organizationId,actorId:null,action:"guest_hub.identity_capture_recorded",resourceType:"guest_hub_identity_documents",resourceId:id,propertyScopeId:row.propertyId,after:{captureId:id,linkId:row.id,reservationId:row.reservationId,grantId:form.grant.id,manifestFingerprint:binding.manifestFingerprint,payloadSha256,outboxEventId:event.id},requestId,occurredAt:createdAt});await repo.validateBirth();return receipt(context,saved,false);
  },true);},
  async recover(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies){const input=guestHubIdentityDocumentRecoverySchema.parse(raw);return visit(capability,deps,async context=>{
   const original=await repository(context).captureByNonce(context.actual.row.id,input.idempotencyKey);
   if(!original)return{recorded:false as const,linkId:context.actual.row.id,idempotencyKey:input.idempotencyKey};
   if(original.grantId!==context.form.grant.id)throw new GuestHubIdentityDocumentConflictError();
   decryptGuestHubIdentityDocumentCapture(original.encryptedPayload,guestHubIdentityCaptureBinding(original),original.fileManifest,deps.env);
   await readAudit(context,"guest_hub.identity_capture_recovered",deps,original.id);return{...receipt(context,original,true),recorded:true as const};
  });}
 };
}
