import {createHash,randomUUID} from "node:crypto";
import type {GuestHubProfileRevision} from "@prisma/client";
import type {AuthContext,Resource} from "@/platform/authz/authorize";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";

import {guestHubProfileDraftSchema,guestHubProfileSubmitSchema,guestHubProfileRecoverySchema,guestHubProfileViewSchema,guestHubProfileReceiptSchema,guestHubProfileReviewSchema,type GuestHubProfileReviewBinding} from "../domain/guest-hub-profile-contract";
import {validateGuestHubProfileValues,presentGuestHubProfileValues,GuestHubProfileAccessError,GuestHubProfileConflictError} from "../domain/guest-hub-profile-policy";
import {signGuestHubProfileReview,verifyGuestHubProfileReview,signGuestHubProfileCommand,verifyGuestHubProfileCommand} from "../domain/guest-hub-profile-signatures";
import {encryptGuestHubProfile,decryptGuestHubProfile,guestHubStoredProfileReview,type GuestHubProfilePayloadBinding} from "../domain/guest-hub-profile-payload";
import {GuestHubProfileRepository} from "../infrastructure/guest-hub-profile-repository";
import {activeGuestHubProfile,guestHubProfileRevisionBinding} from "./guest-hub-profile-source";
import type {GuestHubCapabilityContext,GuestHubVisitDependencies} from "./guest-hub-visit";
import {withGuestHubForm} from "./guest-hub-form-visit";

type ProfileContext=GuestHubCapabilityContext&{profile:Awaited<ReturnType<typeof activeGuestHubProfile>>;profileAuthority:AuthContext;profileResource:Resource};
async function withGuestHubProfile<T>(capability:unknown,deps:GuestHubVisitDependencies,work:(context:ProfileContext)=>Promise<T>,submission=false){return withGuestHubForm(capability,deps,{resourceType:"guest_hub_profile",rateKey:"guest-hub:profile-submit:",active:activeGuestHubProfile,lock:context=>new GuestHubProfileRepository(context.tx,context.actual.row.organizationId).lockProfile(context.actual.row.reservationId,context.actual.row.guestId),AccessError:GuestHubProfileAccessError},context=>work({...context,profile:context.form,profileAuthority:context.formAuthority,profileResource:context.formResource}),submission);}
function reviewBinding(context:ProfileContext,input:ReturnType<typeof guestHubProfileDraftSchema.parse>,previousRevisionId:string|null):GuestHubProfileReviewBinding{
 const {row}=context.actual,profile=context.profile;return{protocol:"NATIVE_GUEST_PROFILE_REVIEW_V1",organizationId:row.organizationId,linkId:row.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,grantId:profile.grant.id,grantFingerprint:profile.grantFingerprint,policyFingerprint:profile.settings.fingerprint,sourceFingerprint:profile.sourceFingerprint,previousRevisionId,idempotencyKey:input.idempotencyKey,values:validateGuestHubProfileValues(input.values,profile.policy,input.acknowledged),acknowledged:input.acknowledged};
}
async function readAudit(context:ProfileContext,action:string,deps:GuestHubVisitDependencies,revisionId?:string){
 await writeAuditEvent(context.tx,{organizationId:context.actual.row.organizationId,actorId:null,action,resourceType:"guest_hub_profile",resourceId:revisionId??context.actual.row.id,propertyScopeId:context.actual.row.propertyId,after:{linkId:context.actual.row.id,reservationId:context.actual.row.reservationId,...revisionId?{revisionId}:{}},requestId:deps.requestId??randomUUID(),occurredAt:await context.actual.repository.clock()});
}
function publicReceipt(context:ProfileContext,row:GuestHubProfileRevision,replayed:boolean){
 return guestHubProfileReceiptSchema.parse(present({...context.profileAuthority,visibleDataClasses:new Set()},"view",{...context.profileResource,data:{id:row.id,linkId:row.linkId,reservationId:row.reservationId,version:row.version,idempotencyKey:row.commandKey,createdAt:row.createdAt.toISOString(),replayed}},catalogFieldPolicy("guest_hub_profile"),context.profile.now));
}
export async function viewGuestHubProfile(capability:unknown,deps:GuestHubVisitDependencies){
 return withGuestHubProfile(capability,deps,async context=>{
  const {row}=context.actual,profile=context.profile,canonical=await profile.repository.canonicalValues(row.reservationId,row.guestId);if(!canonical)throw new GuestHubProfileAccessError();
  const latest=await profile.repository.latestRevision(row.reservationId,row.guestId),payload=latest?decryptGuestHubProfile(latest.encryptedPayload,guestHubProfileRevisionBinding(latest),deps.env):null;
  const data=guestHubProfileViewSchema.parse({linkId:row.id,reservationId:row.reservationId,grantId:profile.grant.id,previousRevisionId:latest?.id??null,allowedFields:profile.policy.allowed,requiredFields:profile.policy.required,notice:profile.policy.notice,requireAcknowledgement:profile.policy.requireAcknowledgement,values:presentGuestHubProfileValues(canonical,payload?.values??null,profile.policy.allowed)});
  await readAudit(context,"guest_hub.profile_opened",deps);return guestHubProfileViewSchema.parse(present({...context.profileAuthority,visibleDataClasses:new Set()},"view",{...context.profileResource,data},catalogFieldPolicy("guest_hub_profile"),profile.now));
 });
}
export async function reviewGuestHubProfile(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies){
 const input=guestHubProfileDraftSchema.parse(raw);return withGuestHubProfile(capability,deps,async context=>{
  const {row}=context.actual,latest=await context.profile.repository.latestRevision(row.reservationId,row.guestId),canonical=await context.profile.repository.canonicalValues(row.reservationId,row.guestId);if(!canonical)throw new GuestHubProfileAccessError();
  const previous=latest?decryptGuestHubProfile(latest.encryptedPayload,guestHubProfileRevisionBinding(latest),deps.env):null,values={...presentGuestHubProfileValues(canonical,previous?.values??null,context.profile.policy.allowed),...input.values},binding=reviewBinding(context,{...input,values},latest?.id??null);
  const data={...input,values:binding.values,grantId:context.profile.grant.id,previousRevisionId:latest?.id??null,reviewFingerprint:signGuestHubProfileReview(binding,deps.env)};
  await readAudit(context,"guest_hub.profile_reviewed",deps);return guestHubProfileReviewSchema.parse(present({...context.profileAuthority,visibleDataClasses:new Set()},"view",{...context.profileResource,data},catalogFieldPolicy("guest_hub_profile"),context.profile.now));
 });
}
export async function submitGuestHubProfile(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies){
 const input=guestHubProfileSubmitSchema.parse(raw);return withGuestHubProfile(capability,deps,async context=>{
  const {row}=context.actual,profile=context.profile,original=await profile.repository.revisionByNonce(row.id,input.idempotencyKey);
  if(original){
   const binding=guestHubProfileRevisionBinding(original),payload=decryptGuestHubProfile(original.encryptedPayload,binding,deps.env),review=guestHubStoredProfileReview(binding,{...payload,values:input.values,acknowledged:input.acknowledged,reviewFingerprint:input.reviewFingerprint});
   if(original.linkId!==row.id||original.reservationId!==row.reservationId||!verifyGuestHubProfileCommand(review,input.reviewFingerprint,original.commandKeyVersion,original.commandHash,deps.env))throw new GuestHubProfileConflictError();
   await readAudit(context,"guest_hub.profile_recovered",deps,original.id);return publicReceipt(context,original,true);
  }
  const latest=await profile.repository.latestRevision(row.reservationId,row.guestId),review=reviewBinding(context,input,latest?.id??null);verifyGuestHubProfileReview(review,input.reviewFingerprint,deps.env);
  await context.actual.repository.lockPolicy(profile.settings.rule.id);
  const command=signGuestHubProfileCommand(review,input.reviewFingerprint,deps.env),id=randomUUID(),createdAt=await context.actual.repository.clock(),requestId=deps.requestId??randomUUID(),binding:GuestHubProfilePayloadBinding={protocol:"NATIVE_GUEST_PROFILE_PAYLOAD_V1",id,organizationId:row.organizationId,linkId:row.id,grantId:profile.grant.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:latest?.id??null,version:(latest?.version??0)+1,commandKey:input.idempotencyKey,commandHash:command.commandHash,commandKeyVersion:command.keyVersion,grantFingerprint:profile.grantFingerprint,policyId:profile.settings.rule.id,policyVersion:profile.settings.rule.version,policyFingerprint:profile.settings.fingerprint,sourceFingerprint:profile.sourceFingerprint,createdAt:createdAt.toISOString()};
  const encryptedPayload=encryptGuestHubProfile({schemaVersion:1,values:review.values,acknowledged:review.acknowledged,reviewFingerprint:input.reviewFingerprint},binding,deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex"),event=await new OutboxRepository(context.tx,row.organizationId).append("guest_hub.profile_submitted",{revisionId:id,linkId:row.id,reservationId:row.reservationId},"guest-hub-profile:"+row.id+":"+input.idempotencyKey,createdAt);
  const saved=await profile.repository.createRevision({id,linkId:row.id,grantId:profile.grant.id,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:latest?.id??null,version:binding.version,commandKey:input.idempotencyKey,commandHash:command.commandHash,commandKeyVersion:command.keyVersion,grantFingerprint:profile.grantFingerprint,policyId:profile.settings.rule.id,policyVersion:profile.settings.rule.version,policyFingerprint:profile.settings.fingerprint,policySnapshot:profile.settings.snapshot,sourceFingerprint:profile.sourceFingerprint,sourceSnapshot:profile.sourceSnapshot,encryptedPayload,payloadSha256,payloadSchema:1,outboxEventId:event.id,createdAt,requestId});
  await writeAuditEvent(context.tx,{organizationId:row.organizationId,actorId:null,action:"guest_hub.profile_submitted",resourceType:"guest_hub_profile",resourceId:id,propertyScopeId:row.propertyId,after:{revisionId:id,linkId:row.id,reservationId:row.reservationId,grantId:profile.grant.id,payloadSha256,outboxEventId:event.id},requestId,occurredAt:createdAt});
  await profile.repository.validateBirth();return publicReceipt(context,saved,false);
 },true);
}
export async function recoverGuestHubProfile(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies){
 const input=guestHubProfileRecoverySchema.parse(raw);return withGuestHubProfile(capability,deps,async context=>{
  const original=await new GuestHubProfileRepository(context.tx,context.actual.row.organizationId).revisionByNonce(context.actual.row.id,input.idempotencyKey);
  if(!original)return{recorded:false as const,linkId:context.actual.row.id,idempotencyKey:input.idempotencyKey};
  // Current form authority suffices for metadata; nonce recovery never decrypts or remints a profile.
  await readAudit(context,"guest_hub.profile_recovered",deps,original.id);return{...publicReceipt(context,original,true),recorded:true as const};
 });
}
