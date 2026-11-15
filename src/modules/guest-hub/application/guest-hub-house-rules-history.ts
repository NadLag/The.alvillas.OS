import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {withTenant} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {GuestHubRepository} from "../infrastructure/guest-hub-repository";
import {GuestHubHouseRulesRepository} from "../infrastructure/guest-hub-house-rules-repository";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {guestHubHouseRulesHistorySchema} from "../domain/guest-hub-house-rules-contract";
import {decryptGuestHubHouseRules} from "../domain/guest-hub-house-rules-private";
import {GuestHubHouseRulesAccessError,GuestHubHouseRulesConflictError} from "../domain/guest-hub-house-rules-policy";
import {signGuestHubDirectoryCursor,readGuestHubDirectoryCursor} from "../domain/guest-hub-directory-cursor";
import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import {guestHubSourceSnapshot} from "./guest-hub-source";
import {guestHubHouseRulesAcceptanceBinding} from "./guest-hub-house-rules-source";
import type {GuestHubDependencies} from "./guest-hub-service";

const inputSchema=z.object({linkId:guestHubIdSchema,cursor:z.string().max(6000).optional()}).strict();

/** Past evidence remains readable under independent held/current staff authority.
 * Withdrawal, link expiry and a later wording decision never rewrite an original. */
export function readGuestHubHouseRulesHistory(actor:AccountActorContext,raw:unknown,deps:GuestHubDependencies){const input=inputSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
 const repository=new GuestHubRepository(tx,actor.organizationId),rules=new GuestHubHouseRulesRepository(tx,actor.organizationId),link=await repository.byId(input.linkId);if(!link)throw new GuestHubHouseRulesAccessError();await repository.lockSources(link.reservationId);const source=await repository.source(link.reservationId);if(!source)throw new GuestHubHouseRulesAccessError();
 const target=await guestHubLinkTarget(repository,link,source),resource={...guestHubResource(actor.organizationId,source,target),type:"guest_hub_house_rules",dataClass:"personal" as const},personal={...guestHubResource(actor.organizationId,source),type:"guest",id:source.guestId,dataClass:"personal" as const,occurredAt:source.guestCreatedAt};
 const phase=async()=>{const now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"view",now,target);await recheckAccountAuthorization(actor,tx,now,[{action:"view",resource},{action:"view",resource:personal}],new GuestHubHouseRulesAccessError());const current=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);return{now,cap:jsonbFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(current)})};};
 const first=await phase(),sourceFingerprint=jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,source)),binding={organizationId:actor.organizationId,actorId:actor.actorId,reservationId:link.reservationId,cap:first.cap,source:sourceFingerprint,policy:jsonbFingerprint({protocol:"NATIVE_GUEST_HOUSE_RULES_HISTORY_V1",linkId:link.id})},cursor=input.cursor?readGuestHubDirectoryCursor(input.cursor,binding,first.now,deps.env):null,asOf=cursor?new Date(cursor.asOf):first.now,rows=await rules.history(link.id,asOf,cursor?{id:cursor.beforeId,createdAt:new Date(cursor.beforeAt)}:undefined),page=rows.slice(0,25),items=page.map(row=>({id:row.id,linkId:row.linkId,reservationId:row.reservationId,grantId:row.grantId,version:row.version,idempotencyKey:row.commandKey,createdAt:row.createdAt.toISOString(),editionFingerprint:row.editionFingerprint,requestedLocale:row.requestedLocale,displayedLocale:row.displayedLocale,payload:decryptGuestHubHouseRules(row.encryptedPayload,guestHubHouseRulesAcceptanceBinding(row),deps.env)})),last=page.at(-1),next=rows.length>25&&last?signGuestHubDirectoryCursor({...binding,protocol:"NATIVE_GUEST_LINK_DIRECTORY_V1",asOf:asOf.toISOString(),beforeId:last.id,beforeAt:last.createdAt.toISOString()},deps.env):null;
 await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.house_rules_history_viewed",resourceType:"guest_hub_house_rules",resourceId:link.id,propertyScopeId:link.propertyId,after:{linkId:link.id,reservationId:link.reservationId,acceptanceIds:page.map(row=>row.id)},requestId:deps.requestId??randomUUID(),occurredAt:first.now});const final=await phase(),actual=await repository.source(link.reservationId);if(final.cap!==first.cap||!actual||jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,actual))!==sourceFingerprint)throw new GuestHubHouseRulesConflictError();
 return guestHubHouseRulesHistorySchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...resource,data:{linkId:link.id,reservationId:link.reservationId,items,next}},catalogFieldPolicy("guest_hub_house_rules"),final.now));
});}
