import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {GuestHubRepository} from "../infrastructure/guest-hub-repository";
import {GuestHubAgreementRepository} from "../infrastructure/guest-hub-agreement-repository";
import {GuestHubAgreementAccessError} from "../domain/guest-hub-agreement-policy";
import {decryptGuestHubAgreementRequest} from "../domain/guest-hub-agreement-private";
import {activeGuestHubAgreement,authenticateGuestHubAgreementRelease,guestHubAgreementRequestBinding} from "./guest-hub-agreement-source";
import {guestHubOriginalBinding,guestHubSettings,currentGuestHubState} from "./guest-hub-source";
import type {GuestHubAgreementReleaseDependencies} from "./guest-hub-agreement-releases";

/** Authentication of original facts remains available after withdrawal. It does
 * not authorize provider operations or disclose retained private payloads. */
export async function retainedGuestHubAgreementDistributionAuthority(tx:TenantTransaction,organizationId:string,requestId:string,env?:NodeJS.ProcessEnv){
 const repository=new GuestHubAgreementRepository(tx,organizationId),request=await repository.request(requestId);if(!request)throw new GuestHubAgreementAccessError();const release=await repository.release(request.releaseId);if(!release)throw new GuestHubAgreementAccessError();
 const authenticated=authenticateGuestHubAgreementRelease(release,env),binding=guestHubAgreementRequestBinding(request),payload=decryptGuestHubAgreementRequest(request.encryptedPayload,binding,env);
 if(release.decision!=="GRANTED"||authenticated.fingerprint!==request.releaseFingerprint||release.linkId!==request.linkId||release.reservationId!==request.reservationId||release.propertyId!==request.propertyId||release.guestId!==request.guestId||release.preparationId!==request.preparationId||release.originalFingerprint!==request.originalFingerprint||jsonbFingerprint(payload.original)!==release.originalFingerprint||createHash("sha256").update(request.encryptedPayload).digest("hex")!==request.payloadSha256)throw new GuestHubAgreementAccessError();
 const actor={organizationId,actorId:release.createdBy,authContext:restoreAuthorizationCap(release.authorizationCap)},provenance={protocol:"NATIVE_GUEST_AGREEMENT_DISTRIBUTION_ORIGIN_V1" as const,organizationId,guestRequestId:request.id,linkId:request.linkId,releaseId:release.id,preparationId:request.preparationId,reservationId:request.reservationId,propertyId:request.propertyId,guestId:request.guestId,delegatedBy:release.createdBy,releaseFingerprint:request.releaseFingerprint,originalFingerprint:request.originalFingerprint,payloadSha256:request.payloadSha256};
 return{repository,request,release,actor,provenance};
}
export async function liveGuestHubAgreementDistributionAuthority(tx:TenantTransaction,organizationId:string,requestId:string,deps:Pick<GuestHubAgreementReleaseDependencies,"agreementDocuments"|"env">){
 const retained=await retainedGuestHubAgreementDistributionAuthority(tx,organizationId,requestId,deps.env),repository=new GuestHubRepository(tx,organizationId);await repository.lockLink(retained.request.linkId);await repository.lockSources(retained.request.reservationId);
 const row=await repository.byId(retained.request.linkId);if(!row)throw new GuestHubAgreementAccessError();guestHubOriginalBinding(row);const source=await repository.source(row.reservationId);if(!source)throw new GuestHubAgreementAccessError();const now=await repository.clock(),settings=await guestHubSettings(tx,organizationId,source,now),state=currentGuestHubState(row,source,settings,!!await repository.revocation(row.id),now);if(state!=="ACTIVE")throw new GuestHubAgreementAccessError();
 const active=await activeGuestHubAgreement({tx,actual:{repository,row,source,now,settings,state}},deps.agreementDocuments,deps.env);
 if(active.release.id!==retained.release.id||active.releaseFingerprint!==retained.request.releaseFingerprint||active.originalFingerprint!==retained.request.originalFingerprint||active.sourceFingerprint!==retained.request.sourceFingerprint)throw new GuestHubAgreementAccessError();return{...retained,active};
}
export type GuestHubAgreementNativeDistribution={id:string;organizationId:string;requestedBy:string;commandKey:string;requestedAt:Date;authorizationCap:unknown};
function sameDelegation(context:Awaited<ReturnType<typeof retainedGuestHubAgreementDistributionAuthority>>,intent:GuestHubAgreementNativeDistribution){if(intent.organizationId!==context.request.organizationId||intent.requestedBy!==context.actor.actorId||intent.commandKey!==context.request.id||jsonbFingerprint(intent.authorizationCap)!==jsonbFingerprint(captureAuthorizationCap(context.actor.authContext)))throw new GuestHubAgreementAccessError();}
export async function assertGuestHubAgreementDistributionOrigin(tx:TenantTransaction,organizationId:string,requestId:string,intent:GuestHubAgreementNativeDistribution,env?:NodeJS.ProcessEnv){
 const context=await retainedGuestHubAgreementDistributionAuthority(tx,organizationId,requestId,env);sameDelegation(context,intent);const origin=await context.repository.documentOrigin(requestId);
 if(!origin||origin.distributionIntentId!==intent.id||origin.delegatedBy!==intent.requestedBy||origin.createdAt.getTime()!==intent.requestedAt.getTime()||jsonbFingerprint(origin.provenance)!==origin.provenanceFingerprint||origin.provenanceFingerprint!==jsonbFingerprint(context.provenance))throw new GuestHubAgreementAccessError();return context;
}
export async function recordGuestHubAgreementDistributionOrigin(tx:TenantTransaction,organizationId:string,requestId:string,intent:GuestHubAgreementNativeDistribution,deps:Pick<GuestHubAgreementReleaseDependencies,"agreementDocuments"|"env">,correlationId:string){
 const context=await liveGuestHubAgreementDistributionAuthority(tx,organizationId,requestId,deps);sameDelegation(context,intent);if(await context.repository.documentOrigin(requestId))throw new GuestHubAgreementAccessError();
 await context.repository.createDocumentOrigin({id:randomUUID(),guestRequestId:requestId,distributionIntentId:intent.id,delegatedBy:intent.requestedBy,provenance:context.provenance,provenanceFingerprint:jsonbFingerprint(context.provenance),createdAt:intent.requestedAt,requestId:correlationId});
}
export async function readGuestHubAgreementDistributionReference(raw:unknown,deps:GuestHubAgreementReleaseDependencies){
 const reference=z.object({organizationId:z.uuid(),outboxEventId:z.uuid()}).strict().parse(raw);return withTenant(deps.db,reference.organizationId,async tx=>{
  const event=await new OutboxRepository(tx,reference.organizationId).event(reference.outboxEventId),input=z.object({guestRequestId:z.uuid(),linkId:z.uuid(),reservationId:z.uuid()}).strict().safeParse(event?.payload);
  if(!event||event.type!=="guest_hub.agreement_signature_requested"||!input.success)throw new GuestHubAgreementAccessError();const context=await liveGuestHubAgreementDistributionAuthority(tx,reference.organizationId,input.data.guestRequestId,deps);
  if(input.data.linkId!==context.request.linkId||input.data.reservationId!==context.request.reservationId||context.request.outboxEventId!==event.id||event.idempotencyKey!=="guest-hub-agreement-request:"+context.request.linkId+":"+context.request.commandKey||event.occurredAt.getTime()!==context.request.createdAt.getTime())throw new GuestHubAgreementAccessError();return{organizationId:reference.organizationId,guestRequestId:context.request.id,actor:context.actor,provenance:context.provenance,origin:await context.repository.documentOrigin(context.request.id)};
 });
}
