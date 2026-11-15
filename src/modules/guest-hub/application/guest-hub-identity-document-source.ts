import type {GuestHubFormGrant} from "@prisma/client";
import {restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {GuestHubIdentityDocumentRepository} from "../infrastructure/guest-hub-identity-document-repository";
import {guestHubIdentityDocumentDelegationBindingSchema,verifyGuestHubIdentityDocumentDelegation} from "../domain/guest-hub-identity-document-delegation";
import {guestHubIdentityDocumentPolicySchema,effectiveGuestHubIdentityDocumentPolicy,GuestHubIdentityDocumentAccessError} from "../domain/guest-hub-identity-document-policy";
import {effectiveGuestHubIdentityDocumentArchive} from "../domain/guest-hub-identity-document-archive";
import {GuestHubAccessError} from "../domain/guest-hub-policy";
import {activeGuestHubForm} from "./guest-hub-form-source";
import {guestHubIdentityDocumentSettings,type GuestHubIdentityDocumentAuthorityProvider} from "./guest-hub-identity-document-grants";
import {guestHubResource,guestHubLinkTarget,requireGuestHubStaffAuthority} from "./guest-hub-access";
import type {GuestHubCapabilityContext} from "./guest-hub-visit";

/** A public identity form retains the real grantor's signed cap and intersects current stored document authority. */
export async function activeGuestHubIdentityDocuments(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,documents:GuestHubIdentityDocumentAuthorityProvider,env:NodeJS.ProcessEnv=process.env,head?:GuestHubFormGrant|null){
 const active=await activeGuestHubForm(context,{formKey:"IDENTITY_DOCUMENTS",settings:guestHubIdentityDocumentSettings,parsePolicy:raw=>guestHubIdentityDocumentPolicySchema.parse(raw),effectivePolicy:effectiveGuestHubIdentityDocumentPolicy,AccessError:GuestHubIdentityDocumentAccessError},env,head),{tx,actual}=context,{grant}=active;
 const repository=new GuestHubIdentityDocumentRepository(tx,actual.row.organizationId),delegation=await repository.delegation(grant.id);if(!delegation||delegation.createdAt.getTime()!==grant.createdAt.getTime())throw new GuestHubIdentityDocumentAccessError();
 const parsed=guestHubIdentityDocumentDelegationBindingSchema.safeParse({protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_DELEGATION_V1",organizationId:actual.row.organizationId,grantId:grant.id,grantFingerprint:active.grantFingerprint,createdBy:grant.createdBy,authorizationCap:grant.authorizationCap,archivePolicy:delegation.archivePolicySnapshot,retentionPolicy:delegation.retentionPolicySnapshot});
 if(!parsed.success||parsed.data.archivePolicy.id!==delegation.archivePolicyId||parsed.data.archivePolicy.version!==delegation.archivePolicyVersion||parsed.data.retentionPolicy.id!==delegation.retentionPolicyId||parsed.data.retentionPolicy.version!==delegation.retentionPolicyVersion||!/^[a-f0-9]{64}$/u.test(delegation.signature)||!verifyGuestHubIdentityDocumentDelegation(parsed.data,delegation.signatureVersion,Buffer.from(delegation.signature,"hex"),env))throw new GuestHubIdentityDocumentAccessError();
 const documentActor={organizationId:actual.row.organizationId,actorId:grant.createdBy,authContext:restoreAuthorizationCap(parsed.data.authorizationCap)},linkTarget=await guestHubLinkTarget(actual.repository,actual.row,actual.source),target=guestHubResource(documentActor.organizationId,actual.source,linkTarget),personal={...guestHubResource(documentActor.organizationId,actual.source),type:"guest",id:actual.source.guestId,dataClass:"personal" as const,occurredAt:actual.source.guestCreatedAt};
 try{
  await requireGuestHubStaffAuthority(documentActor,tx,actual.source,"create",active.now,linkTarget);
  await recheckAccountAuthorization(documentActor,tx,active.now,[{action:"view",resource:{...target,type:"guest_hub_identity_documents"}},{action:"create",resource:{...target,type:"guest_hub_identity_documents"}},{action:"view",resource:personal},{action:"edit",resource:personal}],new GuestHubIdentityDocumentAccessError());
 }catch(error){if(error instanceof GuestHubAccessError)throw new GuestHubIdentityDocumentAccessError();throw error;}
 const captured=guestHubIdentityDocumentPolicySchema.parse((grant.policySnapshot as {value:unknown}).value),current=await documents.capture(documentActor,tx,actual.source,active.now,captured),policy=effectiveGuestHubIdentityDocumentArchive(captured,active.settings.policy,parsed.data,current.archivePolicy,current.retentionPolicy);
 return{...active,repository,documentActor,delegation,policy,archivePolicy:current.archivePolicy,retentionPolicy:current.retentionPolicy,fingerprint:jsonbFingerprint({form:active.fingerprint,delegation:{version:delegation.signatureVersion,signature:delegation.signature},archive:current.archivePolicy,retention:current.retentionPolicy})};
}
