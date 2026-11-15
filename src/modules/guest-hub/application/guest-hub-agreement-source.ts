import type {GuestHubAgreementRelease,GuestHubAgreementRequest} from "@prisma/client";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {GuestHubAgreementRepository} from "../infrastructure/guest-hub-agreement-repository";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {guestHubAgreementPolicyKey,guestHubAgreementPolicySchema,effectiveGuestHubAgreementPolicy,guestHubAgreementTemplate,GuestHubAgreementAccessError} from "../domain/guest-hub-agreement-policy";
import {guestHubAgreementReleaseBindingSchema,guestHubAgreementPayloadBindingSchema,guestHubAgreementLocaleSchema} from "../domain/guest-hub-agreement-contract";
import {verifyGuestHubAgreementRelease} from "../domain/guest-hub-agreement-private";
import {bindGuestHubAgreementOriginal} from "../domain/guest-hub-agreement-source";
import {guestHubFormSettings} from "./guest-hub-form-source";
import {guestHubSourceSnapshot} from "./guest-hub-source";
import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import type {GuestHubCapabilityContext} from "./guest-hub-visit";
import type {GuestHubAgreementDocumentAuthorityProvider} from "./guest-hub-agreement-document-authority";

export function guestHubAgreementSettings(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){return guestHubFormSettings(tx,organizationId,source,now,{policyKey:guestHubAgreementPolicyKey,parsePolicy:(raw:unknown)=>guestHubAgreementPolicySchema.parse(raw),assertPolicy:effectiveGuestHubAgreementPolicy,AccessError:GuestHubAgreementAccessError});}
export function guestHubAgreementReleaseBinding(row:GuestHubAgreementRelease){
 if(jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint||row.decision==="GRANTED"&&(jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.originalSnapshot)!==row.originalFingerprint)||row.decision==="WITHDRAWN"&&(JSON.stringify(row.originalSnapshot)!=="{}"||JSON.stringify(row.policySnapshot)!=="{}"))throw new GuestHubAgreementAccessError();
 return guestHubAgreementReleaseBindingSchema.parse({protocol:"NATIVE_GUEST_AGREEMENT_RELEASE_V1",id:row.id,organizationId:row.organizationId,linkId:row.linkId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,previousId:row.previousId,version:row.version,decision:row.decision,preparationId:row.preparationId,requestedLocale:row.requestedLocale,originalFingerprint:row.originalFingerprint,documentAuthorityFingerprint:row.documentAuthorityFingerprint,linkTokenHash:row.linkTokenHash,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,authorizationCapFingerprint:jsonbFingerprint(row.authorizationCap),commandKey:row.commandKey,commandHash:row.commandHash,reviewFingerprint:row.reviewFingerprint,createdBy:row.createdBy,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString()});
}
export function authenticateGuestHubAgreementRelease(row:GuestHubAgreementRelease,env:NodeJS.ProcessEnv=process.env){
 const binding=guestHubAgreementReleaseBinding(row);
 if(!/^[a-f0-9]{64}$/u.test(row.signature)||!verifyGuestHubAgreementRelease(binding,row.signatureVersion,Buffer.from(row.signature,"hex"),env))throw new GuestHubAgreementAccessError();
 return{binding,fingerprint:jsonbFingerprint({binding,signatureVersion:row.signatureVersion,signature:row.signature})};
}
export async function requireGuestHubAgreementStaffAuthority(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,link:Awaited<ReturnType<typeof guestHubLinkTarget>>,now:Date,action:"view"|"create"|"void"){
 await requireGuestHubStaffAuthority(actor,tx,source,action,now,link);
 const target={...guestHubResource(actor.organizationId,source,link),type:"guest_hub_agreement"},personal={...guestHubResource(actor.organizationId,source),type:"guest",id:source.guestId,dataClass:"personal" as const,occurredAt:source.guestCreatedAt};
 await recheckAccountAuthorization(actor,tx,now,[{action,resource:target},{action:"view",resource:target},{action:"view",resource:personal},{action:"edit",resource:personal}],new GuestHubAgreementAccessError());return target;
}
export async function activeGuestHubAgreement(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,documents:GuestHubAgreementDocumentAuthorityProvider,env:NodeJS.ProcessEnv=process.env){
 const{tx,actual}=context,{row,source}=actual,repository=new GuestHubAgreementRepository(tx,row.organizationId),release=await repository.releaseHead(row.id),now=await actual.repository.clock();if(!release)throw new GuestHubAgreementAccessError();
 const authenticated=authenticateGuestHubAgreementRelease(release,env);
 if(release.decision!=="GRANTED"||release.organizationId!==row.organizationId||release.linkId!==row.id||release.reservationId!==row.reservationId||release.propertyId!==row.propertyId||release.guestId!==row.guestId||release.linkTokenHash!==row.tokenHash||release.createdAt<row.createdAt||release.createdAt>now||release.expiresAt.getTime()!==row.expiresAt.getTime()||release.expiresAt<=now||!release.preparationId||!release.requestedLocale)throw new GuestHubAgreementAccessError();
 const actor={organizationId:row.organizationId,actorId:release.createdBy,authContext:restoreAuthorizationCap(release.authorizationCap)},link=await guestHubLinkTarget(actual.repository,row,source);await requireGuestHubAgreementStaffAuthority(actor,tx,source,link,now,"create");
 const settings=await guestHubAgreementSettings(tx,row.organizationId,source,now),captured=guestHubAgreementPolicySchema.parse((release.policySnapshot as {value:unknown}).value),policy=effectiveGuestHubAgreementPolicy(captured,settings.policy),sourceSnapshot=guestHubSourceSnapshot(row.organizationId,source),sourceFingerprint=jsonbFingerprint(sourceSnapshot);
 if(sourceFingerprint!==release.sourceFingerprint)throw new GuestHubAgreementAccessError();
 const selection=guestHubAgreementTemplate(policy,guestHubAgreementLocaleSchema.parse(release.requestedLocale)),authority=await documents.capture(actor,tx,source,selection,release.preparationId,env),original=bindGuestHubAgreementOriginal(authority.original,{organizationId:row.organizationId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId},selection);
 if(authority.preparationId!==release.preparationId||authority.fingerprint!==release.documentAuthorityFingerprint||original.fingerprint!==release.originalFingerprint)throw new GuestHubAgreementAccessError();
 return{grant:release,release,releaseFingerprint:authenticated.fingerprint,actor,repository,now,settings,policy,sourceSnapshot,sourceFingerprint,original:original.original,originalFingerprint:original.fingerprint,documentLocale:original.documentLocale,authority,fingerprint:jsonbFingerprint({release:authenticated.fingerprint,policy:settings.fingerprint,source:sourceFingerprint,document:authority.fingerprint})};
}
export function guestHubAgreementRequestBinding(row:GuestHubAgreementRequest){
 if(row.payloadSchema!==1||jsonbFingerprint(row.policySnapshot)!==row.policyFingerprint||jsonbFingerprint(row.sourceSnapshot)!==row.sourceFingerprint)throw new GuestHubAgreementAccessError();
 return guestHubAgreementPayloadBindingSchema.parse({protocol:"NATIVE_GUEST_AGREEMENT_REQUEST_PAYLOAD_V1",id:row.id,organizationId:row.organizationId,linkId:row.linkId,reservationId:row.reservationId,propertyId:row.propertyId,guestId:row.guestId,releaseId:row.releaseId,releaseFingerprint:row.releaseFingerprint,preparationId:row.preparationId,commandKey:row.commandKey,commandHash:row.commandHash,commandKeyVersion:row.commandKeyVersion,originalFingerprint:row.originalFingerprint,policyId:row.policyId,policyVersion:row.policyVersion,policyFingerprint:row.policyFingerprint,sourceFingerprint:row.sourceFingerprint,requestedLocale:row.requestedLocale,documentLocale:row.documentLocale,createdAt:row.createdAt.toISOString()});
}
