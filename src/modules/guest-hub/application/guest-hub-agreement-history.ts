import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {withTenant} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {GuestHubRepository} from "../infrastructure/guest-hub-repository";
import {GuestHubAgreementRepository} from "../infrastructure/guest-hub-agreement-repository";
import {guestHubAgreementHistorySchema} from "../domain/guest-hub-agreement-contract";
import {GuestHubAgreementAccessError,GuestHubAgreementConflictError} from "../domain/guest-hub-agreement-policy";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {signGuestHubDirectoryCursor,readGuestHubDirectoryCursor} from "../domain/guest-hub-directory-cursor";
import {decryptGuestHubAgreementRequest} from "../domain/guest-hub-agreement-private";
import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import {guestHubSourceSnapshot} from "./guest-hub-source";
import {guestHubAgreementRequestBinding} from "./guest-hub-agreement-source";
import {retainedGuestHubAgreementDistributionAuthority} from "./guest-hub-agreement-distribution-authority";
import type {GuestHubAgreementReleaseDependencies} from "./guest-hub-agreement-releases";

/** Historical wording remains readable after withdrawal or processing changes.
 * Each staff reader independently needs the native original document authority. */
export function readGuestHubAgreementHistory(actor:AccountActorContext,raw:unknown,deps:GuestHubAgreementReleaseDependencies){const input=z.object({linkId:guestHubIdSchema,cursor:z.string().max(6000).optional()}).strict().parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
 const repository=new GuestHubRepository(tx,actor.organizationId),agreements=new GuestHubAgreementRepository(tx,actor.organizationId),link=await repository.byId(input.linkId);if(!link)throw new GuestHubAgreementAccessError();await repository.lockSources(link.reservationId);const source=await repository.source(link.reservationId);if(!source)throw new GuestHubAgreementAccessError();
 const target=await guestHubLinkTarget(repository,link,source),resource={...guestHubResource(actor.organizationId,source,target),type:"guest_hub_agreement",dataClass:"personal" as const},personal={...guestHubResource(actor.organizationId,source),type:"guest",id:source.guestId,dataClass:"personal" as const,occurredAt:source.guestCreatedAt};
 const phase=async()=>{const now=await repository.clock();await requireGuestHubStaffAuthority(actor,tx,source,"view",now,target);await recheckAccountAuthorization(actor,tx,now,[{action:"view",resource},{action:"view",resource:personal}],new GuestHubAgreementAccessError());const current=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);return{now,cap:jsonbFingerprint({held:captureAuthorizationCap(actor.authContext),current:captureAuthorizationCap(current)})};};
 const first=await phase(),sourceFingerprint=jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,source)),binding={organizationId:actor.organizationId,actorId:actor.actorId,reservationId:link.reservationId,cap:first.cap,source:sourceFingerprint,policy:jsonbFingerprint({protocol:"NATIVE_GUEST_AGREEMENT_HISTORY_V1",linkId:link.id})},cursor=input.cursor?readGuestHubDirectoryCursor(input.cursor,binding,first.now,deps.env):null,asOf=cursor?new Date(cursor.asOf):first.now,rows=await agreements.history(link.id,asOf,cursor?{id:cursor.beforeId,createdAt:new Date(cursor.beforeAt)}:undefined),page=rows.slice(0,25),items=[];
 for(const row of page){await retainedGuestHubAgreementDistributionAuthority(tx,actor.organizationId,row.id,deps.env);const payload=decryptGuestHubAgreementRequest(row.encryptedPayload,guestHubAgreementRequestBinding(row),deps.env);await deps.agreementDocuments.history(actor,tx,payload.original,deps.env);items.push({id:row.id,linkId:row.linkId,reservationId:row.reservationId,releaseId:row.releaseId,idempotencyKey:row.commandKey,createdAt:row.createdAt.toISOString(),requestedLocale:row.requestedLocale,documentLocale:row.documentLocale,payload});}
 const last=page.at(-1),next=rows.length>25&&last?signGuestHubDirectoryCursor({...binding,protocol:"NATIVE_GUEST_LINK_DIRECTORY_V1",asOf:asOf.toISOString(),beforeId:last.id,beforeAt:last.createdAt.toISOString()},deps.env):null;
 await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"guest_hub.agreement_history_viewed",resourceType:"guest_hub_agreement",resourceId:link.id,propertyScopeId:link.propertyId,after:{linkId:link.id,reservationId:link.reservationId,guestRequestIds:page.map(row=>row.id)},requestId:deps.requestId??randomUUID(),occurredAt:first.now});const final=await phase(),actual=await repository.source(link.reservationId);if(final.cap!==first.cap||!actual||jsonbFingerprint(guestHubSourceSnapshot(actor.organizationId,actual))!==sourceFingerprint)throw new GuestHubAgreementConflictError();
 for(const item of items)await deps.agreementDocuments.history(actor,tx,item.payload.original,deps.env);
 return guestHubAgreementHistorySchema.parse(present({...actor.authContext,visibleDataClasses:new Set()},"view",{...resource,data:{linkId:link.id,reservationId:link.reservationId,items,next}},catalogFieldPolicy("guest_hub_agreement"),final.now));
});}
