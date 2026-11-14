import {randomUUID} from "node:crypto";
import type {GuestHubLink} from "@prisma/client";
import {z} from "zod";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {authorize,type AuthContext} from "@/platform/authz/authorize";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {guestHubPublicInputSchema,guestHubPublicViewSchema,guestHubIdSchema,type GuestHubCapabilityClaims} from "../domain/guest-hub-contract";
import {verifyGuestHubCapability,guestHubCapabilityDigest} from "../domain/guest-hub-capability";
import {guestHubVerificationPolicyKey,guestHubVerificationPolicySchema,effectiveGuestHubExpiry,GuestHubConfigurationError,GuestHubInvalidLinkError,GuestHubRateLimitError} from "../domain/guest-hub-policy";
import {GuestHubRepository} from "../infrastructure/guest-hub-repository";
import {currentGuestHubState,guestHubSettings,guestHubOriginalBinding,guestHubSourceSnapshot} from "./guest-hub-source";
import {guestHubResource,guestHubLinkTarget} from "./guest-hub-access";
import type {GuestHubDependencies} from "./guest-hub-service";

export type GuestHubVisitDependencies=GuestHubDependencies&{clientKey:string;verificationOrganizationId?:string;expectedLinkId?:string};
const clientKeySchema=z.string().min(1).max(200);
async function consumeVerificationBudget(deps:GuestHubVisitDependencies){
 const organizationId=deps.verificationOrganizationId??bootstrapOrganizationId,client=clientKeySchema.parse(deps.clientKey);
 const allowed=await withTenant(deps.db,organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,organizationId),now=await repository.clock(),rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:guestHubVerificationPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
  if(!rule?.createdBy||rule.lifecycle!=="ACTIVE")throw new GuestHubConfigurationError();const policy=guestHubVerificationPolicySchema.parse(rule.parsedValue);if(!policy.enabled)throw new GuestHubConfigurationError();
  const global=await consumeRateLimit(tx,organizationId,{key:"guest-hub:verification:global",limit:policy.checks.requests,windowSeconds:policy.checks.window_seconds,now}),local=await consumeRateLimit(tx,organizationId,{key:"guest-hub:verification:client:"+client,limit:policy.clients.requests,windowSeconds:policy.clients.window_seconds,now});return global.allowed&&local.allowed;
 });if(!allowed)throw new GuestHubRateLimitError();
}
function assertOriginal(row:GuestHubLink|null,claims:GuestHubCapabilityClaims,token:string):asserts row is GuestHubLink{
 if(!row||row.organizationId!==claims.organizationId||row.id!==claims.linkId||row.reservationId!==claims.reservationId||row.propertyId!==claims.propertyId||row.guestId!==claims.guestId||row.createdAt.toISOString()!==claims.issuedAt||row.expiresAt.toISOString()!==claims.expiresAt||row.tokenHash!==guestHubCapabilityDigest(token))throw new GuestHubInvalidLinkError();
 guestHubOriginalBinding(row);
}
async function actualSource(tx:TenantTransaction,claims:GuestHubCapabilityClaims,token:string){
 const repository=new GuestHubRepository(tx,claims.organizationId),row=await repository.byId(claims.linkId);assertOriginal(row,claims,token);
 const source=await repository.source(row.reservationId);if(!source)throw new GuestHubInvalidLinkError();const now=await repository.clock(),settings=await guestHubSettings(tx,claims.organizationId,source,now),state=currentGuestHubState(row,source,settings,!!await repository.revocation(row.id),now);
 return{repository,row,source,now,settings,state};
}
/** Ephemeral authority is constructed only after original database identity and current eligibility succeed. */
function visitorAuthority(row:GuestHubLink):AuthContext{
 const permission="guest_hub:view",scope={organizationId:row.organizationId,resourceType:"guest_hub",resourceId:row.id};
 return{organizationId:row.organizationId,permissions:new Set([permission]),scopes:[scope],assignments:[{permissions:new Set([permission]),scope,validFrom:row.createdAt,validTo:row.expiresAt}]};
}

export async function visitGuestHubLink(raw:unknown,deps:GuestHubVisitDependencies){
 // No unverified token byte selects a tenant, policy, quota or native record.
 await consumeVerificationBudget(deps);
 let token:string,claims:GuestHubCapabilityClaims;
 try{token=guestHubPublicInputSchema.parse(raw).token;claims=verifyGuestHubCapability(token,deps.env);if(deps.expectedLinkId&&claims.linkId!==guestHubIdSchema.parse(deps.expectedLinkId))throw new GuestHubInvalidLinkError();}catch{throw new GuestHubInvalidLinkError();}
 try{
  const budget=await withTenant(deps.db,claims.organizationId,async tx=>{
   const actual=await actualSource(tx,claims,token),policy=actual.settings.policy.reads;
   const organization=await consumeRateLimit(tx,claims.organizationId,{key:"guest-hub:read:organization",limit:policy.requests,windowSeconds:policy.window_seconds,now:actual.now}),link=await consumeRateLimit(tx,claims.organizationId,{key:"guest-hub:read:"+actual.row.id,limit:policy.requests,windowSeconds:policy.window_seconds,now:actual.now});
   return{allowed:organization.allowed&&link.allowed,active:actual.state==="ACTIVE"};
  });if(!budget.allowed)throw new GuestHubRateLimitError();if(!budget.active)throw new GuestHubInvalidLinkError();
  return await withTenant(deps.db,claims.organizationId,async tx=>{
   const repository=new GuestHubRepository(tx,claims.organizationId);await repository.lockLink(claims.linkId);await repository.lockSources(claims.reservationId);
   const actual=await actualSource(tx,claims,token);if(actual.state!=="ACTIVE")throw new GuestHubInvalidLinkError();
   const authority=visitorAuthority(actual.row),resource=guestHubResource(claims.organizationId,actual.source,await guestHubLinkTarget(actual.repository,actual.row,actual.source));if(!authorize(authority,"view",resource,actual.now))throw new GuestHubInvalidLinkError();
   const data=guestHubPublicViewSchema.parse({id:actual.row.id,reservationId:actual.row.reservationId,propertyId:actual.row.propertyId,checkIn:actual.source.checkIn.toISOString().slice(0,10),checkOut:actual.source.checkOut.toISOString().slice(0,10),expiresAt:effectiveGuestHubExpiry(actual.settings.policy,actual.row.expiresAt,actual.source.checkOut.toISOString().slice(0,10),actual.source.timezone).toISOString(),timezone:actual.source.timezone,state:"ACTIVE",locale:actual.source.locale});
   await writeAuditEvent(tx,{organizationId:claims.organizationId,actorId:null,action:"guest_hub.link_opened",resourceType:"guest_hub",resourceId:actual.row.id,propertyScopeId:actual.row.propertyId,after:{linkId:actual.row.id,reservationId:actual.row.reservationId},requestId:deps.requestId??randomUUID(),occurredAt:actual.now});
   const final=await actualSource(tx,claims,token);if(final.state!=="ACTIVE"||final.settings.fingerprint!==actual.settings.fingerprint||jsonbFingerprint(guestHubSourceSnapshot(claims.organizationId,final.source))!==jsonbFingerprint(guestHubSourceSnapshot(claims.organizationId,actual.source)))throw new GuestHubInvalidLinkError();
   return guestHubPublicViewSchema.parse(present({...authority,visibleDataClasses:new Set()},"view",{...resource,data},catalogFieldPolicy("guest_hub"),final.now));
  });
 }catch(error){if(error instanceof GuestHubRateLimitError)throw error;throw new GuestHubInvalidLinkError();}
}
