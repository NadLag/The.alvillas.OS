import {randomUUID} from "node:crypto";
import type {Action,Resource} from "@/platform/authz/authorize";
import {authorizeCollection} from "@/platform/authz/authorize";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {GuestHubRepository,type GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubDirectoryInputSchema,guestHubLinkSummarySchema,guestHubWorkspaceSchema} from "../domain/guest-hub-contract";
import {signGuestHubDirectoryCursor,readGuestHubDirectoryCursor} from "../domain/guest-hub-directory-cursor";
import {configuredGuestHubExpiry,GuestHubAccessError,GuestHubConflictError,GuestHubConfigurationError,type GuestHubLinkState} from "../domain/guest-hub-policy";
import {guestHubResource,guestHubSourceChecks} from "./guest-hub-access";
import {guestHubSettings,guestHubSourceSnapshot,currentGuestHubState} from "./guest-hub-source";
import type {GuestHubDependencies} from "./guest-hub-service";

async function phase(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource){
 const now=await new GuestHubRepository(tx,actor.organizationId).clock(),stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);
 assertAccountAuthorization(actor,stored,now,guestHubSourceChecks(actor.organizationId,source),new GuestHubAccessError());
 if(![actor.authContext,stored].every(context=>authorizeCollection(context,"view","guest_hub")))throw new GuestHubAccessError();
 return{now,stored,cap:jsonbFingerprint({held:captureAuthorizationCap(actor.authContext),stored:captureAuthorizationCap(stored)})};
}
function allowed(actor:AccountActorContext,current:Awaited<ReturnType<typeof phase>>,resource:Resource,action:Action){
 try{assertAccountAuthorization(actor,current.stored,current.now,[{action,resource}],new GuestHubAccessError());return true;}catch(error){if(error instanceof GuestHubAccessError)return false;throw error;}
}
async function settingsOrUnavailable(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){try{return await guestHubSettings(tx,organizationId,source,now);}catch(error){if(error instanceof GuestHubConfigurationError)return null;throw error;}}
function eligible(source:GuestHubNativeSource,settings:Awaited<ReturnType<typeof settingsOrUnavailable>>,now:Date){
 if(!settings||!source.sourceAvailable||!settings.policy.enabled||!settings.policy.processing_approval_reference||!settings.policy.allowed_reservation_states.some(state=>state===source.reservationStatus))return false;
 try{return configuredGuestHubExpiry(settings.policy,source.checkOut.toISOString().slice(0,10),source.timezone)>now;}catch(error){if(error instanceof GuestHubConfigurationError)return false;throw error;}
}

/** Paginate immutable identities; every visible record is checked against held and current source authority. */
export async function readGuestHubWorkspace(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){
 const input=guestHubDirectoryInputSchema.parse(raw);
 return withTenant(deps.db,actor.organizationId,async tx=>{
  const repository=new GuestHubRepository(tx,actor.organizationId);await repository.lockSources(input.reservationId);const source=await repository.source(input.reservationId);if(!source)throw new GuestHubAccessError();
  const first=await phase(actor,tx,source),settings=await settingsOrUnavailable(tx,actor.organizationId,source,first.now),sourceFingerprint=jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,source)),binding={organizationId:actor.organizationId,actorId:actor.actorId,reservationId:source.reservationId,cap:first.cap,source:sourceFingerprint,policy:settings?.fingerprint??null},cursor=input.cursor?readGuestHubDirectoryCursor(input.cursor,binding,first.now,deps.env):null,asOf=cursor?new Date(cursor.asOf):first.now;
  type Row=Awaited<ReturnType<GuestHubRepository["history"]>>[number];
  const selected:Array<{row:Row;target:{id:string;propertyId:string;createdAt:Date;city:string;region:string}}>=[];let position=cursor?{id:cursor.beforeId,createdAt:new Date(cursor.beforeAt)}:undefined;
  // Keep allocations bounded and look ahead to an actually visible record; hidden rows never become page hints.
  while(selected.length<26){
   const candidates=await repository.history(source.reservationId,asOf,position),batch=candidates.slice(0,100),properties=await repository.propertyDimensionsMany([...new Set(batch.map(row=>row.propertyId))]),byProperty=new Map(properties.map(row=>[row.id,row]));
   for(const row of batch){const property=byProperty.get(row.propertyId);if(!property)throw new GuestHubConflictError();position={id:row.id,createdAt:row.createdAt};const target={id:row.id,propertyId:row.propertyId,createdAt:row.createdAt,city:property.cityId??property.city,region:property.regionId??property.region};if(!allowed(actor,first,guestHubResource(actor.organizationId,source,target),"view"))continue;selected.push({row,target});if(selected.length===26)break;}
   if(selected.length===26||candidates.length<=100)break;
  }
  const page=selected.slice(0,25).map(item=>item.row),byTarget=new Map(selected.map(item=>[item.row.id,item.target]));
  const heads=await repository.revocationHeads(page.map(row=>row.id)),byHead=new Map(heads.map(row=>[row.linkId,row.id]));if(page.some(row=>(row.revocations[0]?.id??null)!==(byHead.get(row.id)??null)))throw new GuestHubConflictError();
  const currentSource=await repository.source(source.reservationId);if(!currentSource)throw new GuestHubAccessError();const current=await phase(actor,tx,currentSource),currentSettings=await settingsOrUnavailable(tx,actor.organizationId,currentSource,current.now);
  if(current.cap!==first.cap||jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,currentSource))!==sourceFingerprint||(currentSettings?.fingerprint??null)!==binding.policy)throw new GuestHubConflictError();
  const items=[];
  for(const row of page){
   const target=byTarget.get(row.id);if(!target)throw new GuestHubConflictError();const resource=guestHubResource(actor.organizationId,currentSource,target);if(!allowed(actor,current,resource,"view"))continue;
   const revoked=row.revocations.length>0;let state:GuestHubLinkState=revoked?"REVOKED":row.expiresAt<=current.now?"EXPIRED":"BLOCKED";
   if(!revoked&&currentSettings){try{state=currentGuestHubState(row,currentSource,currentSettings,false,current.now);}catch(error){if(!(error instanceof GuestHubConfigurationError))throw error;}}
   const originalCreator=row.createdBy===actor.actorId,recoverable=originalCreator&&allowed(actor,current,resource,"create"),data={id:row.id,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),state,originalCreator,...recoverable?{recoveryKey:row.commandKey}:{},canRevoke:!revoked&&allowed(actor,current,resource,"void")};
   items.push(guestHubLinkSummarySchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...resource,data},catalogFieldPolicy("guest_hub"),current.now)));
  }
  const creationResource={...guestHubResource(actor.organizationId,currentSource),occurredAt:current.now},last=page.at(-1),lookahead=selected[25],next=lookahead&&last&&allowed(actor,current,guestHubResource(actor.organizationId,currentSource,lookahead.target),"view")?signGuestHubDirectoryCursor({...binding,protocol:"NATIVE_GUEST_LINK_DIRECTORY_V1",asOf:asOf.toISOString(),beforeId:last.id,beforeAt:last.createdAt.toISOString()},deps.env):null;
  const data=guestHubWorkspaceSchema.parse({reservationId:source.reservationId,propertyId:source.propertyId,reference:source.reference,locale:source.locale,timezone:source.timezone,checkedAt:current.now.toISOString(),canCreate:allowed(actor,current,creationResource,"create")&&allowed(actor,current,creationResource,"view"),issuanceAvailable:eligible(currentSource,currentSettings,current.now),items,next});
  await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.workspace_read",resourceType:"reservation",resourceId:source.reservationId,propertyScopeId:source.propertyId,after:{reservationId:source.reservationId,count:items.length,hasNext:!!next},requestId:deps.requestId??randomUUID(),occurredAt:current.now});
  const resource={...guestHubResource(actor.organizationId,currentSource),type:"reservation",id:source.reservationId,data};return guestHubWorkspaceSchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",resource,catalogFieldPolicy("reservation"),current.now));
 });
}
