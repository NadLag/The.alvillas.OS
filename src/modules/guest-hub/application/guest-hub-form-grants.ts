import type {Prisma} from "@prisma/client";
import type {PermissionResource} from "@/platform/authz/catalog";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import type {GuestHubFormKey} from "../domain/guest-hub-form-grant-contract";
import {randomUUID} from "node:crypto";
import {z,ZodError} from "zod";
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
import {GuestHubFormGrantRepository} from "../infrastructure/guest-hub-form-grant-repository";
import {guestHubFormGrantDraftSchema,guestHubFormGrantCommandSchema,guestHubFormGrantRecoverySchema,guestHubFormGrantReceiptSchema,guestHubFormGrantStatusSchema} from "../domain/guest-hub-form-grant-contract";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {GuestHubAccessError,GuestHubConfigurationError} from "../domain/guest-hub-policy";
import {signGuestHubFormGrant} from "../domain/guest-hub-form-grant-signatures";

import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import {currentGuestHubState,guestHubSettings,guestHubSourceSnapshot} from "./guest-hub-source";

import type {GuestHubDependencies} from "./guest-hub-service";

type Decision="GRANTED"|"WITHDRAWN";
type Settings={rule:{id:string;version:number};snapshot:Prisma.InputJsonObject;fingerprint:string};
export type GuestHubFormGrantExtension={fingerprint:string;policyIds:readonly string[];snapshot:Prisma.InputJsonObject};
type GrantExtension={context:(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,now:Date,settings:Settings)=>Promise<GuestHubFormGrantExtension>;record:(actor:AccountActorContext,tx:TenantTransaction,grant:GuestHubFormGrant,extension:GuestHubFormGrantExtension,deps:GuestHubDependencies)=>Promise<void>};
type Definition={resourceType:PermissionResource;reviewProtocol:string;settings:(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date)=>Promise<Settings>;AccessError:new()=>Error;ConflictError:new()=>Error}&({formKey:Exclude<GuestHubFormKey,"IDENTITY_DOCUMENTS">;extension?:never}|{formKey:"IDENTITY_DOCUMENTS";extension:GrantExtension});
export function createGuestHubFormGrantService(definition:Definition){
async function grantContext(actor:AccountActorContext,tx:TenantTransaction,linkId:string,decision:Decision|null,requireEnabled=true){
 const repository=new GuestHubRepository(tx,actor.organizationId),profiles=new GuestHubFormGrantRepository(tx,actor.organizationId,definition.formKey),row=await repository.byId(linkId);if(!row)throw new definition.AccessError();
 const source=await repository.source(row.reservationId);if(!source)throw new definition.AccessError();const now=await repository.clock(),linkTarget=await guestHubLinkTarget(repository,row,source),target={...guestHubResource(actor.organizationId,source,linkTarget),type:definition.resourceType},action=decision===null?"view":decision==="GRANTED"?"create":"void";
 await requireGuestHubStaffAuthority(actor,tx,source,action,now,linkTarget);
 const personal={...guestHubResource(actor.organizationId,source),type:"guest",id:source.guestId,dataClass:"personal" as const,occurredAt:source.guestCreatedAt};
 await recheckAccountAuthorization(actor,tx,now,[{action,resource:target},{action:"view",resource:target},{action:"view",resource:personal},{action:"edit",resource:personal}],new definition.AccessError());
 let settings:Awaited<ReturnType<typeof definition.settings>>|null=null;
 if(decision==="GRANTED"&&requireEnabled){
  const linkSettings=await guestHubSettings(tx,actor.organizationId,source,now);if(currentGuestHubState(row,source,linkSettings,!!await repository.revocation(row.id),now)!=="ACTIVE")throw new definition.AccessError();
  settings=await definition.settings(tx,actor.organizationId,source,now);
 }
 const head=await profiles.grantHead(row.id),sourceSnapshot=guestHubSourceSnapshot(actor.organizationId,source);
 const extension=settings&&definition.extension?await definition.extension.context(actor,tx,source,now,settings):null;
 const fingerprint=jsonbFingerprint({protocol:definition.reviewProtocol,organizationId:actor.organizationId,actorId:actor.actorId,linkId:row.id,linkTokenHash:row.tokenHash,source:sourceSnapshot,headId:head?.id??null,headVersion:head?.version??0,decision,policy:settings?.snapshot??null,...extension?{additionalAuthority:extension.fingerprint}:{}});
 return{repository,profiles,row,source,sourceSnapshot,now,target,settings,head,extension,fingerprint};
}
async function guestHubFormGrantStatus(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=z.object({linkId:guestHubIdSchema}).strict().parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockLink(input.linkId);const initial=await grantContext(actor,tx,input.linkId,null,false);
  const permitted=async(decision:Decision)=>{try{await grantContext(actor,tx,input.linkId,decision);return true;}catch(error){if(error instanceof definition.AccessError||error instanceof GuestHubAccessError||error instanceof GuestHubConfigurationError||error instanceof ZodError)return false;throw error;}};
  const canGrant=await permitted("GRANTED"),canWithdraw=!!initial.head&&initial.head.decision!=="WITHDRAWN"&&await permitted("WITHDRAWN"),final=await grantContext(actor,tx,input.linkId,null,false);
  const data={linkId:final.row.id,reservationId:final.row.reservationId,decision:final.head?.decision??null,version:final.head?.version??0,canGrant,canWithdraw};
  return guestHubFormGrantStatusSchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...final.target,data},catalogFieldPolicy(definition.resourceType),final.now));
 });
}
function receipt(actor:AccountActorContext,context:Awaited<ReturnType<typeof grantContext>>,row:GuestHubFormGrant,replayed:boolean){
 return guestHubFormGrantReceiptSchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...context.target,data:{id:row.id,linkId:row.linkId,reservationId:row.reservationId,propertyId:row.propertyId,decision:row.decision,version:row.version,idempotencyKey:row.commandKey,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),replayed}},catalogFieldPolicy(definition.resourceType),context.now));
}
async function reviewGuestHubProfileGrant(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubFormGrantDraftSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const context=await grantContext(actor,tx,input.linkId,input.decision);return{linkId:context.row.id,reservationId:context.row.reservationId,decision:input.decision,expiresAt:context.row.expiresAt.toISOString(),reviewFingerprint:context.fingerprint};});
}
async function recordGuestHubProfileGrant(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubFormGrantCommandSchema.parse(raw),commandHash=commandFingerprint(input);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);await repository.lockLink(input.linkId);
  const first=await repository.byId(input.linkId);if(!first)throw new definition.AccessError();await repository.lockSources(first.reservationId);
  const profiles=new GuestHubFormGrantRepository(tx,actor.organizationId,definition.formKey),original=await profiles.grantByNonce(input.idempotencyKey),context=await grantContext(actor,tx,input.linkId,input.decision,!original);
  if(original){if(original.formKey!==definition.formKey||original.createdBy!==actor.actorId)throw new definition.AccessError();if(original.linkId!==input.linkId||original.commandHash!==commandHash)throw new definition.ConflictError();return receipt(actor,context,original,true);}
  if(context.fingerprint!==input.reviewFingerprint)throw new definition.ConflictError();if(context.settings)await repository.lockPolicy(context.settings.rule.id);
  for(const policyId of [...new Set(context.extension?.policyIds??[])].sort())await repository.lockPolicy(policyId);
  const now=new Date(Math.floor(context.now.getTime())),id=randomUUID(),requestId=deps.requestId??randomUUID(),sourceFingerprint=jsonbFingerprint(context.sourceSnapshot),version=(context.head?.version??0)+1;
  const binding={protocol:"NATIVE_GUEST_FORM_GRANT_V1",formKey:definition.formKey,id,organizationId:actor.organizationId,linkId:context.row.id,reservationId:context.row.reservationId,propertyId:context.row.propertyId,guestId:context.row.guestId,previousId:context.head?.id??null,version,decision:input.decision,linkTokenHash:context.row.tokenHash,policyId:context.settings?.rule.id??null,policyVersion:context.settings?.rule.version??null,policyFingerprint:context.settings?.fingerprint??null,sourceFingerprint,createdBy:actor.actorId,createdAt:now.toISOString(),expiresAt:context.row.expiresAt.toISOString(),commandKey:input.idempotencyKey,commandHash};
  const signed=signGuestHubFormGrant(binding,deps.env);let signature:string;try{signature=signed.signature.toString("hex");}finally{signed.signature.fill(0);}
  const event=await new OutboxRepository(tx,actor.organizationId).append("guest_hub.form_grant_recorded",{grantId:id,linkId:context.row.id,reservationId:context.row.reservationId,formKey:definition.formKey,decision:input.decision},"guest-hub-form-grant:"+actor.actorId+":"+input.idempotencyKey,now);
  const saved=await context.profiles.createGrant({id,linkId:context.row.id,reservationId:context.row.reservationId,propertyId:context.row.propertyId,guestId:context.row.guestId,formKey:definition.formKey,previousId:context.head?.id??null,version,decision:input.decision,linkTokenHash:context.row.tokenHash,policyId:context.settings?.rule.id??null,policyVersion:context.settings?.rule.version??null,policyFingerprint:context.settings?.fingerprint??null,policySnapshot:context.settings?.snapshot??{},sourceFingerprint,sourceSnapshot:context.sourceSnapshot,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,signatureVersion:signed.version,signature,authorizationCap:captureAuthorizationCap(actor.authContext),outboxEventId:event.id,reason:input.reason,createdBy:actor.actorId,createdAt:now,expiresAt:context.row.expiresAt,requestId});
  if(context.extension&&definition.extension)await definition.extension.record(actor,tx,saved,context.extension,deps);
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.form_grant_recorded",resourceType:definition.resourceType,resourceId:id,propertyScopeId:saved.propertyId,after:{grantId:id,linkId:saved.linkId,reservationId:saved.reservationId,formKey:definition.formKey,decision:input.decision,commandHash,outboxEventId:event.id},reason:input.reason,requestId,occurredAt:now});
  const final=await grantContext(actor,tx,input.linkId,input.decision);if(final.head?.id!==saved.id||final.settings?.fingerprint!==context.settings?.fingerprint||final.extension?.fingerprint!==context.extension?.fingerprint||jsonbFingerprint(final.sourceSnapshot)!==sourceFingerprint)throw new definition.ConflictError();
  await context.profiles.validateBirth();return receipt(actor,final,saved,false);
 });
}
async function recoverGuestHubProfileGrant(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubFormGrantRecoverySchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId),profiles=new GuestHubFormGrantRepository(tx,actor.organizationId,definition.formKey);await repository.lockCommand(input.idempotencyKey);await repository.lockLink(input.linkId);
  const original=await profiles.grantByNonce(input.idempotencyKey);if(original&&(original.formKey!==definition.formKey||original.createdBy!==actor.actorId||original.linkId!==input.linkId))throw new definition.AccessError();
  // Recovery never needs a private key or processing enablement; the recorded decision stays metadata.
  const decision=guestHubFormGrantDraftSchema.parse({linkId:input.linkId,decision:original?.decision??input.decision??"GRANTED"}).decision,context=await grantContext(actor,tx,input.linkId,decision,false);if(!original)return{recorded:false as const,linkId:input.linkId,idempotencyKey:input.idempotencyKey};
  if(input.decision&&input.decision!==original.decision)throw new definition.ConflictError();
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.form_grant_recovered",resourceType:definition.resourceType,resourceId:original.id,propertyScopeId:original.propertyId,after:{grantId:original.id,linkId:original.linkId,reservationId:original.reservationId},requestId:deps.requestId??randomUUID(),occurredAt:context.now});
  return{...receipt(actor,context,original,true),recorded:true as const};
 });
}

return{status:guestHubFormGrantStatus,review:reviewGuestHubProfileGrant,record:recordGuestHubProfileGrant,recover:recoverGuestHubProfileGrant};
}
