import {randomUUID} from "node:crypto";
import {guestHubHome} from "./guest-hub-home";
import type {GuestHubLink} from "@prisma/client";
import {activeGuestHubHouseRules} from "./guest-hub-house-rules-source";
import {activeGuestHubAgreement} from "./guest-hub-agreement-source";
import type {GuestHubAgreementDocumentAuthorityProvider} from "./guest-hub-agreement-document-authority";
import {GuestHubAgreementAccessError} from "../domain/guest-hub-agreement-policy";
import {GuestHubHouseRulesAccessError} from "../domain/guest-hub-house-rules-policy";
import {z,ZodError} from "zod";
import {activeGuestHubProfile} from "./guest-hub-profile-source";
import {GuestHubProfileAccessError} from "../domain/guest-hub-profile-policy";
import {activeGuestHubStayDetails} from "./guest-hub-stay-details-source";
import {activeGuestHubIdentityDocuments} from "./guest-hub-identity-document-source";
import type {GuestHubIdentityDocumentAuthorityProvider} from "./guest-hub-identity-document-grants";
import {GuestHubIdentityDocumentAccessError} from "../domain/guest-hub-identity-document-policy";
import {GuestHubStayDetailsAccessError} from "../domain/guest-hub-stay-details-policy";
import {GuestHubFormGrantRepository} from "../infrastructure/guest-hub-form-grant-repository";
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

export type GuestHubVisitDependencies=GuestHubDependencies&{clientKey:string;verificationOrganizationId?:string;expectedLinkId?:string;identityDocuments?:GuestHubIdentityDocumentAuthorityProvider;agreementDocuments?:GuestHubAgreementDocumentAuthorityProvider};
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

export type GuestHubCapabilityContext={tx:TenantTransaction;actual:Awaited<ReturnType<typeof actualSource>>;authority:AuthContext;resource:ReturnType<typeof guestHubResource>};

/** A request-scoped lease rechecks the original capability inside an existing tenant transaction.
 * Object I/O belongs between calls, after each transaction releases its native locks. */
export async function createGuestHubCapabilityLease(raw:unknown,deps:GuestHubVisitDependencies,additionalBudget?:(context:Pick<GuestHubCapabilityContext,"tx"|"actual">)=>Promise<boolean>){
 // No unverified token byte selects a tenant, policy, quota or native record.
 await consumeVerificationBudget(deps);
 let token:string,claims:GuestHubCapabilityClaims;
 try{token=guestHubPublicInputSchema.parse(raw).token;claims=verifyGuestHubCapability(token,deps.env);if(deps.expectedLinkId&&claims.linkId!==guestHubIdSchema.parse(deps.expectedLinkId))throw new GuestHubInvalidLinkError();}catch{throw new GuestHubInvalidLinkError();}
 try{
  const budget=await withTenant(deps.db,claims.organizationId,async tx=>{
   const actual=await actualSource(tx,claims,token),policy=actual.settings.policy.reads;
   const link=await consumeRateLimit(tx,claims.organizationId,{key:"guest-hub:read:"+actual.row.id,limit:policy.requests,windowSeconds:policy.window_seconds,now:actual.now});
   const extra=link.allowed&&actual.state==="ACTIVE"&&additionalBudget?await additionalBudget({tx,actual}):true;
   return{allowed:link.allowed&&extra,active:actual.state==="ACTIVE"};
  });if(!budget.allowed)throw new GuestHubRateLimitError();if(!budget.active)throw new GuestHubInvalidLinkError();
  let expectedSource:string|undefined;
  return Object.freeze({organizationId:claims.organizationId,linkId:claims.linkId,async run<T>(tx:TenantTransaction,work:(context:GuestHubCapabilityContext)=>Promise<T>,fence?:(context:GuestHubCapabilityContext)=>Promise<void>):Promise<T>{try{
   const repository=new GuestHubRepository(tx,claims.organizationId);await repository.lockLink(claims.linkId);await repository.lockSources(claims.reservationId);
   const actual=await actualSource(tx,claims,token);if(actual.state!=="ACTIVE")throw new GuestHubInvalidLinkError();
   const sourceFingerprint=jsonbFingerprint({policy:actual.settings.fingerprint,source:guestHubSourceSnapshot(claims.organizationId,actual.source)});
   if(expectedSource!==undefined&&sourceFingerprint!==expectedSource)throw new GuestHubInvalidLinkError();expectedSource=sourceFingerprint;
   const authority=visitorAuthority(actual.row),resource=guestHubResource(claims.organizationId,actual.source,await guestHubLinkTarget(actual.repository,actual.row,actual.source));if(!authorize(authority,"view",resource,actual.now))throw new GuestHubInvalidLinkError();
   const result=await work({tx,actual,authority,resource});
   const final=await actualSource(tx,claims,token);if(final.state!=="ACTIVE"||final.settings.fingerprint!==actual.settings.fingerprint||jsonbFingerprint(guestHubSourceSnapshot(claims.organizationId,final.source))!==jsonbFingerprint(guestHubSourceSnapshot(claims.organizationId,actual.source))||!authorize(authority,"view",resource,final.now))throw new GuestHubInvalidLinkError();
   await fence?.({tx,actual:final,authority,resource});return result;
  }catch(error){if(error instanceof GuestHubRateLimitError)throw error;throw new GuestHubInvalidLinkError();}}});
 }catch(error){if(error instanceof GuestHubRateLimitError)throw error;throw new GuestHubInvalidLinkError();}
}

export type GuestHubCapabilityLease=Awaited<ReturnType<typeof createGuestHubCapabilityLease>>;
/** Every existing native Guest Hub flow retains the same verified, budgeted transaction boundary. */
export async function withGuestHubCapability<T>(raw:unknown,deps:GuestHubVisitDependencies,work:(context:GuestHubCapabilityContext)=>Promise<T>,additionalBudget?:(context:Pick<GuestHubCapabilityContext,"tx"|"actual">)=>Promise<boolean>,fence?:(context:GuestHubCapabilityContext)=>Promise<void>){
 const lease=await createGuestHubCapabilityLease(raw,deps,additionalBudget);
 try{return await withTenant(deps.db,lease.organizationId,tx=>lease.run(tx,work,fence));}
 catch(error){if(error instanceof GuestHubRateLimitError)throw error;throw new GuestHubInvalidLinkError();}
}

async function formAvailability(context:GuestHubCapabilityContext,env?:NodeJS.ProcessEnv,documents?:GuestHubIdentityDocumentAuthorityProvider,agreements?:GuestHubAgreementDocumentAuthorityProvider){
 const heads=await new GuestHubFormGrantRepository(context.tx,context.actual.row.organizationId,"PROFILE").headsForLink(context.actual.row.id),selected=new Map(heads.map(row=>[row.formKey,row]));
 const available=async(work:()=>Promise<{fingerprint:string}>)=>{try{return(await work()).fingerprint;}catch(error){if(error instanceof GuestHubProfileAccessError||error instanceof GuestHubStayDetailsAccessError||error instanceof GuestHubIdentityDocumentAccessError||error instanceof GuestHubHouseRulesAccessError||error instanceof GuestHubAgreementAccessError||error instanceof ZodError)return null;throw error;}};
 return{agreement:agreements?await available(()=>activeGuestHubAgreement(context,agreements,env)):null,houseRules:await available(()=>activeGuestHubHouseRules(context,env,selected.get("HOUSE_RULES")??null)),profile:await available(()=>activeGuestHubProfile(context,env,selected.get("PROFILE")??null)),stayDetails:await available(()=>activeGuestHubStayDetails(context,env,selected.get("STAY_DETAILS")??null)),identityDocuments:documents?await available(()=>activeGuestHubIdentityDocuments(context,documents,env,selected.get("IDENTITY_DOCUMENTS")??null)):null};
}
export async function visitGuestHubLink(raw:unknown,deps:GuestHubVisitDependencies){
 let expectedHome:string|null|undefined,expectedForms:string|undefined;
 return withGuestHubCapability(raw,deps,async(context)=>{
  const {tx,actual,authority,resource}=context;
  const organizationId=actual.row.organizationId,home=await guestHubHome(tx,organizationId,actual.source,actual.settings.scopes,actual.now,deps.env);
  const forms=await formAvailability(context,deps.env,deps.identityDocuments,deps.agreementDocuments);expectedHome=home.fingerprint;expectedForms=jsonbFingerprint(forms);
  const data=guestHubPublicViewSchema.parse({home:{...home.data,...forms.profile?{profileAvailable:true}:{},...forms.stayDetails?{stayDetailsAvailable:true}:{},...forms.identityDocuments?{identityDocumentsAvailable:true}:{},...forms.houseRules?{houseRulesAvailable:true}:{},...forms.agreement?{agreementAvailable:true}:{}},id:actual.row.id,reservationId:actual.row.reservationId,propertyId:actual.row.propertyId,checkIn:actual.source.checkIn.toISOString().slice(0,10),checkOut:actual.source.checkOut.toISOString().slice(0,10),expiresAt:effectiveGuestHubExpiry(actual.settings.policy,actual.row.expiresAt,actual.source.checkOut.toISOString().slice(0,10),actual.source.timezone).toISOString(),timezone:actual.source.timezone,state:"ACTIVE",locale:actual.source.locale});
  await writeAuditEvent(tx,{organizationId,actorId:null,action:"guest_hub.link_opened",resourceType:"guest_hub",resourceId:actual.row.id,propertyScopeId:actual.row.propertyId,after:{linkId:actual.row.id,reservationId:actual.row.reservationId},requestId:deps.requestId??randomUUID(),occurredAt:actual.now});
  return guestHubPublicViewSchema.parse(present({...authority,visibleDataClasses:new Set()},"view",{...resource,data},catalogFieldPolicy("guest_hub"),actual.now));
 },undefined,async context=>{
  const {tx,actual}=context,home=await guestHubHome(tx,actual.row.organizationId,actual.source,actual.settings.scopes,actual.now,deps.env);
  if(home.fingerprint!==expectedHome||jsonbFingerprint(await formAvailability(context,deps.env,deps.identityDocuments,deps.agreementDocuments))!==expectedForms)throw new GuestHubInvalidLinkError();
 });
}
