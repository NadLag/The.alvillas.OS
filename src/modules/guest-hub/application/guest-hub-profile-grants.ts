import {randomUUID} from "node:crypto";
import type {GuestHubFormGrant} from "@prisma/client";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {commandFingerprint,jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {GuestHubRepository} from "../infrastructure/guest-hub-repository";
import {GuestHubProfileRepository} from "../infrastructure/guest-hub-profile-repository";
import {guestHubProfileGrantDraftSchema,guestHubProfileGrantCommandSchema,guestHubProfileGrantRecoverySchema,guestHubProfileGrantReceiptSchema} from "../domain/guest-hub-profile-contract";
import {signGuestHubFormGrant} from "../domain/guest-hub-profile-signatures";
import {GuestHubProfileAccessError,GuestHubProfileConflictError} from "../domain/guest-hub-profile-policy";
import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import {currentGuestHubState,guestHubSettings,guestHubSourceSnapshot} from "./guest-hub-source";
import {guestHubProfileSettings} from "./guest-hub-profile-source";
import type {GuestHubDependencies} from "./guest-hub-service";

type Decision="GRANTED"|"WITHDRAWN";
async function grantContext(actor:AccountActorContext,tx:TenantTransaction,linkId:string,decision:Decision,requireEnabled=true){
 const repository=new GuestHubRepository(tx,actor.organizationId),profiles=new GuestHubProfileRepository(tx,actor.organizationId),row=await repository.byId(linkId);if(!row)throw new GuestHubProfileAccessError();
 const source=await repository.source(row.reservationId);if(!source)throw new GuestHubProfileAccessError();const now=await repository.clock(),linkTarget=await guestHubLinkTarget(repository,row,source),target={...guestHubResource(actor.organizationId,source,linkTarget),type:"guest_hub_profile"},action=decision==="GRANTED"?"create":"void";
 await requireGuestHubStaffAuthority(actor,tx,source,action,now,linkTarget);
 const personal={...guestHubResource(actor.organizationId,source),type:"guest",id:source.guestId,dataClass:"personal" as const,occurredAt:source.guestCreatedAt};
 await recheckAccountAuthorization(actor,tx,now,[{action,resource:target},{action:"view",resource:target},{action:"view",resource:personal},{action:"edit",resource:personal}],new GuestHubProfileAccessError());
 let settings:Awaited<ReturnType<typeof guestHubProfileSettings>>|null=null;
 if(decision==="GRANTED"&&requireEnabled){
  const linkSettings=await guestHubSettings(tx,actor.organizationId,source,now);if(currentGuestHubState(row,source,linkSettings,!!await repository.revocation(row.id),now)!=="ACTIVE")throw new GuestHubProfileAccessError();
  settings=await guestHubProfileSettings(tx,actor.organizationId,linkSettings.scopes,now);
 }
 const head=await profiles.grantHead(row.id),sourceSnapshot=guestHubSourceSnapshot(actor.organizationId,source);
 const fingerprint=jsonbFingerprint({protocol:"NATIVE_GUEST_PROFILE_GRANT_REVIEW_V1",organizationId:actor.organizationId,actorId:actor.actorId,linkId:row.id,linkTokenHash:row.tokenHash,source:sourceSnapshot,headId:head?.id??null,headVersion:head?.version??0,decision,policy:settings?.snapshot??null});
 return{repository,profiles,row,source,sourceSnapshot,now,target,settings,head,fingerprint};
}
function receipt(actor:AccountActorContext,context:Awaited<ReturnType<typeof grantContext>>,row:GuestHubFormGrant,replayed:boolean){
 return guestHubProfileGrantReceiptSchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...context.target,data:{id:row.id,linkId:row.linkId,reservationId:row.reservationId,propertyId:row.propertyId,decision:row.decision,version:row.version,idempotencyKey:row.commandKey,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),replayed}},catalogFieldPolicy("guest_hub_profile"),context.now));
}
export async function reviewGuestHubProfileGrant(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubProfileGrantDraftSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const context=await grantContext(actor,tx,input.linkId,input.decision);return{linkId:context.row.id,reservationId:context.row.reservationId,decision:input.decision,expiresAt:context.row.expiresAt.toISOString(),reviewFingerprint:context.fingerprint};});
}
export async function recordGuestHubProfileGrant(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubProfileGrantCommandSchema.parse(raw),commandHash=commandFingerprint(input);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);await repository.lockLink(input.linkId);
  const first=await repository.byId(input.linkId);if(!first)throw new GuestHubProfileAccessError();await repository.lockSources(first.reservationId);
  const profiles=new GuestHubProfileRepository(tx,actor.organizationId),original=await profiles.grantByNonce(input.idempotencyKey),context=await grantContext(actor,tx,input.linkId,input.decision,!original);
  if(original){if(original.createdBy!==actor.actorId)throw new GuestHubProfileAccessError();if(original.linkId!==input.linkId||original.commandHash!==commandHash)throw new GuestHubProfileConflictError();return receipt(actor,context,original,true);}
  if(context.fingerprint!==input.reviewFingerprint)throw new GuestHubProfileConflictError();if(context.settings)await repository.lockPolicy(context.settings.rule.id);
  const now=new Date(Math.floor(context.now.getTime())),id=randomUUID(),requestId=deps.requestId??randomUUID(),sourceFingerprint=jsonbFingerprint(context.sourceSnapshot),version=(context.head?.version??0)+1;
  const binding={protocol:"NATIVE_GUEST_FORM_GRANT_V1",formKey:"PROFILE",id,organizationId:actor.organizationId,linkId:context.row.id,reservationId:context.row.reservationId,propertyId:context.row.propertyId,guestId:context.row.guestId,previousId:context.head?.id??null,version,decision:input.decision,linkTokenHash:context.row.tokenHash,policyId:context.settings?.rule.id??null,policyVersion:context.settings?.rule.version??null,policyFingerprint:context.settings?.fingerprint??null,sourceFingerprint,createdBy:actor.actorId,createdAt:now.toISOString(),expiresAt:context.row.expiresAt.toISOString(),commandKey:input.idempotencyKey,commandHash};
  const signed=signGuestHubFormGrant(binding,deps.env);let signature:string;try{signature=signed.signature.toString("hex");}finally{signed.signature.fill(0);}
  const event=await new OutboxRepository(tx,actor.organizationId).append("guest_hub.form_grant_recorded",{grantId:id,linkId:context.row.id,reservationId:context.row.reservationId,formKey:"PROFILE",decision:input.decision},"guest-hub-form-grant:"+actor.actorId+":"+input.idempotencyKey,now);
  const saved=await context.profiles.createGrant({id,linkId:context.row.id,reservationId:context.row.reservationId,propertyId:context.row.propertyId,guestId:context.row.guestId,formKey:"PROFILE",previousId:context.head?.id??null,version,decision:input.decision,linkTokenHash:context.row.tokenHash,policyId:context.settings?.rule.id??null,policyVersion:context.settings?.rule.version??null,policyFingerprint:context.settings?.fingerprint??null,policySnapshot:context.settings?.snapshot??{},sourceFingerprint,sourceSnapshot:context.sourceSnapshot,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,signatureVersion:signed.version,signature,authorizationCap:captureAuthorizationCap(actor.authContext),outboxEventId:event.id,reason:input.reason,createdBy:actor.actorId,createdAt:now,expiresAt:context.row.expiresAt,requestId});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.form_grant_recorded",resourceType:"guest_hub_profile",resourceId:id,propertyScopeId:saved.propertyId,after:{grantId:id,linkId:saved.linkId,reservationId:saved.reservationId,formKey:"PROFILE",decision:input.decision,commandHash,outboxEventId:event.id},reason:input.reason,requestId,occurredAt:now});
  const final=await grantContext(actor,tx,input.linkId,input.decision);if(final.head?.id!==saved.id||final.settings?.fingerprint!==context.settings?.fingerprint||jsonbFingerprint(final.sourceSnapshot)!==sourceFingerprint)throw new GuestHubProfileConflictError();
  await context.profiles.validateBirth();return receipt(actor,final,saved,false);
 });
}
export async function recoverGuestHubProfileGrant(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubProfileGrantRecoverySchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId),profiles=new GuestHubProfileRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);await repository.lockLink(input.linkId);
  const original=await profiles.grantByNonce(input.idempotencyKey);if(original&&(original.createdBy!==actor.actorId||original.linkId!==input.linkId))throw new GuestHubProfileAccessError();
  // Recovery never needs a private key or processing enablement; the recorded decision stays metadata.
  const decision=guestHubProfileGrantDraftSchema.parse({linkId:input.linkId,decision:original?.decision??"GRANTED"}).decision,context=await grantContext(actor,tx,input.linkId,decision,false);if(!original)return{recorded:false as const,linkId:input.linkId,idempotencyKey:input.idempotencyKey};
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.form_grant_recovered",resourceType:"guest_hub_profile",resourceId:original.id,propertyScopeId:original.propertyId,after:{grantId:original.id,linkId:original.linkId,reservationId:original.reservationId},requestId:deps.requestId??randomUUID(),occurredAt:context.now});
  return{...receipt(actor,context,original,true),recorded:true as const};
 });
}
