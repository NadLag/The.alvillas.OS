import {createHash,randomUUID} from "node:crypto";
import type {GuestHubLink} from "@prisma/client";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {commandFingerprint,jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {GuestHubRepository,type GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubIssueDraftSchema,guestHubIssueCommandSchema,guestHubRevokeDraftSchema,guestHubRevokeCommandSchema,guestHubRecoveryInputSchema,guestHubStaffReceiptSchema,guestHubRecoveryResultSchema,guestHubRevocationRecoveryInputSchema,guestHubRevocationRecoveryResultSchema} from "../domain/guest-hub-contract";
import {issueGuestHubCapability} from "../domain/guest-hub-capability";
import {encryptGuestHubPayload,decryptGuestHubPayload} from "../domain/guest-hub-payload";
import {configuredGuestHubExpiry,GuestHubAccessError,GuestHubConflictError,GuestHubConfigurationError,GuestHubRateLimitError} from "../domain/guest-hub-policy";
import {requireGuestHubStaffAuthority,guestHubResource,guestHubLinkTarget} from "./guest-hub-access";
import {guestHubSettings,guestHubSourceSnapshot,guestHubOriginalBinding,currentGuestHubState} from "./guest-hub-source";

export type GuestHubDependencies={db:TenantTransactionRunner;env?:NodeJS.ProcessEnv;requestId?:string};
type Settings=Awaited<ReturnType<typeof guestHubSettings>>;
function reviewFingerprint(actor:AccountActorContext,source:GuestHubNativeSource,settings:Settings){return jsonbFingerprint({kind:"GUEST_HUB_ISSUE_V1",organizationId:actor.organizationId,actorId:actor.actorId,source:guestHubSourceSnapshot(actor.organizationId,source),policy:settings.snapshot});}
function expiry(source:GuestHubNativeSource,settings:Settings,now:Date){
 const expiresAt=configuredGuestHubExpiry(settings.policy,source.checkOut.toISOString().slice(0,10),source.timezone);
 if(!source.sourceAvailable||!settings.policy.enabled||!settings.policy.processing_approval_reference||!settings.policy.allowed_reservation_states.some(value=>value===source.reservationStatus)||expiresAt<=now)throw new GuestHubConfigurationError();
 return expiresAt;
}
async function sourceFor(repository:GuestHubRepository,reservationId:string){const source=await repository.source(reservationId);if(!source)throw new GuestHubAccessError();return source;}
async function issueFence(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,expected:Settings,row:GuestHubLink){
 const repository=new GuestHubRepository(tx,actor.organizationId),now=await repository.clock(),current=await sourceFor(repository,source.reservationId),settings=await guestHubSettings(tx,actor.organizationId,current,now);
 if(jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,current))!==jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,source))||settings.fingerprint!==expected.fingerprint)throw new GuestHubConflictError();
 await requireGuestHubStaffAuthority(actor,tx,current,"create",now,await guestHubLinkTarget(repository,row,current));expiry(current,settings,now);
}
async function privateReceipt(actor:AccountActorContext,tx:TenantTransaction,row:GuestHubLink,replayed:boolean,deps:GuestHubDependencies){
 if(row.createdBy!==actor.actorId)throw new GuestHubAccessError();
 const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockSources(row.reservationId);
 const source=await sourceFor(repository,row.reservationId),now=await repository.clock(),target=await guestHubLinkTarget(repository,row,source);
 await requireGuestHubStaffAuthority(actor,tx,source,"create",now,target);
 const settings=await guestHubSettings(tx,actor.organizationId,source,now),revoked=!!await repository.revocation(row.id),state=currentGuestHubState(row,source,settings,revoked,now);
 const token=state==="ACTIVE"?decryptGuestHubPayload(row.encryptedPayload,guestHubOriginalBinding(row),deps.env).token:undefined;
 const finalNow=await repository.clock(),finalSource=await sourceFor(repository,row.reservationId),finalSettings=await guestHubSettings(tx,actor.organizationId,finalSource,finalNow);
 await requireGuestHubStaffAuthority(actor,tx,finalSource,"create",finalNow,await guestHubLinkTarget(repository,row,finalSource));
 if(finalSettings.fingerprint!==settings.fingerprint||jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,finalSource))!==jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,source))||currentGuestHubState(row,finalSource,finalSettings,!!await repository.revocation(row.id),finalNow)!==state)throw new GuestHubConflictError();
 const data={id:row.id,reservationId:row.reservationId,propertyId:row.propertyId,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),state,replayed,...token?{token}:{}};
 return guestHubStaffReceiptSchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...guestHubResource(actor.organizationId,source,target),data},catalogFieldPolicy("guest_hub"),finalNow));
}

export async function reviewGuestHubIssue(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubIssueDraftSchema.parse(raw);
 return withTenant(deps.db,actor.organizationId,async tx=>{const repository=new GuestHubRepository(tx,actor.organizationId),source=await sourceFor(repository,input.reservationId),now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"create",now);const settings=await guestHubSettings(tx,actor.organizationId,source,now);return{reservationId:source.reservationId,propertyId:source.propertyId,expiresAt:expiry(source,settings,now).toISOString(),reviewFingerprint:reviewFingerprint(actor,source,settings)};});
}

export async function issueGuestHubLink(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubIssueCommandSchema.parse(raw),commandHash=commandFingerprint(input);
 // This transaction commits the configured attempt budgets even when admission later fails or is denied.
 const allowed=await withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId),original=await repository.byNonce(input.idempotencyKey);
  if(original&&original.createdBy!==actor.actorId)throw new GuestHubAccessError();
  if(original&&original.reservationId!==input.reservationId)throw new GuestHubConflictError();
  const source=await sourceFor(repository,input.reservationId),now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"create",now,original?await guestHubLinkTarget(repository,original,source):undefined);
  const settings=await guestHubSettings(tx,actor.organizationId,source,now),budget=settings.policy.issuance;
  const organization=await consumeRateLimit(tx,actor.organizationId,{key:"guest-hub:issue:organization",limit:budget.requests,windowSeconds:budget.window_seconds,now}),issuer=await consumeRateLimit(tx,actor.organizationId,{key:"guest-hub:issue:"+actor.actorId,limit:budget.requests,windowSeconds:budget.window_seconds,now});return organization.allowed&&issuer.allowed;
 });if(!allowed)throw new GuestHubRateLimitError();
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);
  const original=await repository.byNonce(input.idempotencyKey);if(original){if(original.createdBy!==actor.actorId)throw new GuestHubAccessError();if(original.commandHash!==commandHash||original.reservationId!==input.reservationId)throw new GuestHubConflictError();await repository.lockLink(original.id);return privateReceipt(actor,tx,original,true,deps);}
  await repository.lockSources(input.reservationId);const source=await sourceFor(repository,input.reservationId),now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"create",now);
  const settings=await guestHubSettings(tx,actor.organizationId,source,now);await repository.lockPolicy(settings.rule.id);
  if(input.reviewFingerprint!==reviewFingerprint(actor,source,settings))throw new GuestHubConflictError();
  const expiresAt=expiry(source,settings,now),id=randomUUID(),sourceSnapshot=guestHubSourceSnapshot(actor.organizationId,source),sourceFingerprint=jsonbFingerprint(sourceSnapshot),requestId=deps.requestId??randomUUID();
  const issued=issueGuestHubCapability({organizationId:actor.organizationId,linkId:id,reservationId:source.reservationId,propertyId:source.propertyId,guestId:source.guestId,issuedAt:now.toISOString(),expiresAt:expiresAt.toISOString()},deps.env);
  const binding={organizationId:actor.organizationId,linkId:id,reservationId:source.reservationId,propertyId:source.propertyId,guestId:source.guestId,issuedAt:now.toISOString(),expiresAt:expiresAt.toISOString(),createdBy:actor.actorId,policyId:settings.rule.id,policyVersion:settings.rule.version,commandKey:input.idempotencyKey,commandHash,policyFingerprint:settings.fingerprint,sourceFingerprint,tokenHash:issued.tokenHash};
  const encryptedPayload=encryptGuestHubPayload({schemaVersion:1,token:issued.token},binding,deps.env),payloadSha256=createHash("sha256").update(encryptedPayload).digest("hex");
  const event=await new OutboxRepository(tx,actor.organizationId).append("guest_hub.link_issued",{linkId:id,reservationId:source.reservationId},"guest-hub-issued:"+actor.actorId+":"+input.idempotencyKey,now);
  const row=await repository.create({id,reservationId:source.reservationId,propertyId:source.propertyId,guestId:source.guestId,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,sourceFingerprint,sourceSnapshot,tokenHash:issued.tokenHash,encryptedPayload,payloadSha256,payloadSchema:1,policyId:settings.rule.id,policyVersion:settings.rule.version,policyFingerprint:settings.fingerprint,policySnapshot:settings.snapshot,authorizationCap:captureAuthorizationCap(actor.authContext),outboxEventId:event.id,createdBy:actor.actorId,createdAt:now,expiresAt,requestId});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.link_issued",resourceType:"guest_hub",resourceId:id,propertyScopeId:source.propertyId,after:{linkId:id,reservationId:source.reservationId,commandHash,payloadSha256,sourceFingerprint,outboxEventId:event.id},reason:input.reason,requestId,occurredAt:now});
  await issueFence(actor,tx,source,settings,row);await repository.validateBirth();return privateReceipt(actor,tx,row,false,deps);
 });
}

export async function recoverGuestHubLink(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubRecoveryInputSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);const original=await repository.byNonce(input.idempotencyKey);
  if(!original){if(!input.reservationId)throw new GuestHubAccessError();const source=await sourceFor(repository,input.reservationId);await requireGuestHubStaffAuthority(actor,tx,source,"create",await repository.clock());return guestHubRecoveryResultSchema.parse({recorded:false,reservationId:source.reservationId,idempotencyKey:input.idempotencyKey});}
  if(original.createdBy!==actor.actorId)throw new GuestHubAccessError();if(input.reservationId&&input.reservationId!==original.reservationId)throw new GuestHubConflictError();await repository.lockLink(original.id);await repository.lockSources(original.reservationId);
  return guestHubRecoveryResultSchema.parse({...await privateReceipt(actor,tx,original,true,deps),recorded:true,idempotencyKey:input.idempotencyKey});
 });
}

export async function recoverGuestHubRevocation(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubRevocationRecoveryInputSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);await repository.lockLink(input.linkId);
  const row=await repository.byId(input.linkId);if(!row)throw new GuestHubAccessError();const source=await sourceFor(repository,row.reservationId);await requireGuestHubStaffAuthority(actor,tx,source,"void",await repository.clock(),await guestHubLinkTarget(repository,row,source));
  const original=await repository.revocationByNonce(input.idempotencyKey);if(!original)return guestHubRevocationRecoveryResultSchema.parse({recorded:false,linkId:row.id,idempotencyKey:input.idempotencyKey,alreadyRevoked:!!await repository.revocation(row.id)});
  if(original.createdBy!==actor.actorId)throw new GuestHubAccessError();if(original.linkId!==row.id)throw new GuestHubConflictError();return guestHubRevocationRecoveryResultSchema.parse({recorded:true,id:original.id,linkId:row.id,idempotencyKey:input.idempotencyKey,createdAt:original.createdAt.toISOString()});
 });
}

function revokeFingerprint(actor:AccountActorContext,row:GuestHubLink,revocationId:string|null){return jsonbFingerprint({kind:"GUEST_HUB_REVOKE_V1",organizationId:actor.organizationId,actorId:actor.actorId,linkId:row.id,payloadSha256:row.payloadSha256,revocationId});}
export async function reviewGuestHubRevocation(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubRevokeDraftSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{const repository=new GuestHubRepository(tx,actor.organizationId),row=await repository.byId(input.linkId);if(!row)throw new GuestHubAccessError();const source=await sourceFor(repository,row.reservationId),now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"void",now,await guestHubLinkTarget(repository,row,source));const revoked=await repository.revocation(row.id);return{linkId:row.id,reservationId:row.reservationId,revoked:!!revoked,reviewFingerprint:revokeFingerprint(actor,row,revoked?.id??null)};});
}
export async function revokeGuestHubLink(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubRevokeCommandSchema.parse(raw),commandHash=commandFingerprint(input);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockCommand(input.idempotencyKey);await repository.lockLink(input.linkId);
  const row=await repository.byId(input.linkId);if(!row)throw new GuestHubAccessError();const source=await sourceFor(repository,row.reservationId),now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"void",now,await guestHubLinkTarget(repository,row,source));
  const original=await repository.revocationByNonce(input.idempotencyKey);if(original){if(original.createdBy!==actor.actorId)throw new GuestHubAccessError();if(original.linkId!==row.id||original.commandHash!==commandHash)throw new GuestHubConflictError();return{id:original.id,linkId:row.id,createdAt:original.createdAt.toISOString(),replayed:true};}
  const revoked=await repository.revocation(row.id);if(revoked||input.reviewFingerprint!==revokeFingerprint(actor,row,null))throw new GuestHubConflictError();
  const id=randomUUID(),requestId=deps.requestId??randomUUID(),event=await new OutboxRepository(tx,actor.organizationId).append("guest_hub.link_revoked",{linkId:row.id,revocationId:id},"guest-hub-revoked:"+actor.actorId+":"+input.idempotencyKey,now);
  const saved=await repository.revoke({id,linkId:row.id,commandKey:input.idempotencyKey,commandHash,reviewFingerprint:input.reviewFingerprint,reason:input.reason,outboxEventId:event.id,authorizationCap:captureAuthorizationCap(actor.authContext),createdBy:actor.actorId,createdAt:now,requestId});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.link_revoked",resourceType:"guest_hub",resourceId:row.id,propertyScopeId:source.propertyId,after:{linkId:row.id,revocationId:id,commandHash,outboxEventId:event.id},reason:input.reason,requestId,occurredAt:now});
  await requireGuestHubStaffAuthority(actor,tx,source,"void",await repository.clock(),await guestHubLinkTarget(repository,row,source));await repository.validateBirth();return{id:saved.id,linkId:row.id,createdAt:saved.createdAt.toISOString(),replayed:false};
 });
}
