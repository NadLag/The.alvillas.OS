import {z} from "zod";
import type {Prisma} from "@prisma/client";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {GuestHubIdentityDocumentRepository} from "../infrastructure/guest-hub-identity-document-repository";
import {guestHubIdentityDocumentDelegationBindingSchema,signGuestHubIdentityDocumentDelegation,type GuestHubIdentityDocumentDelegationBinding} from "../domain/guest-hub-identity-document-delegation";
import {guestHubIdentityDocumentPolicyKey,guestHubIdentityDocumentPolicySchema,effectiveGuestHubIdentityDocumentPolicy,GuestHubIdentityDocumentAccessError,GuestHubIdentityDocumentConflictError,type GuestHubIdentityDocumentPolicy} from "../domain/guest-hub-identity-document-policy";
import {intersectGuestHubIdentityDocumentArchivePolicies} from "../domain/guest-hub-identity-document-archive";
import {guestHubFormSettings,authenticateGuestHubFormGrant} from "./guest-hub-form-source";
import {createGuestHubFormGrantService} from "./guest-hub-form-grants";

export type GuestHubIdentityDocumentArchiveAuthority=Pick<GuestHubIdentityDocumentDelegationBinding,"archivePolicy"|"retentionPolicy">;
/** The app composition supplies canonical document source, sensitive creation and retention-edit authorization. */
export interface GuestHubIdentityDocumentAuthorityProvider{
 capture(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,now:Date,policy:GuestHubIdentityDocumentPolicy):Promise<GuestHubIdentityDocumentArchiveAuthority>;
}
const policies=z.object({archivePolicy:guestHubIdentityDocumentDelegationBindingSchema.shape.archivePolicy,retentionPolicy:guestHubIdentityDocumentDelegationBindingSchema.shape.retentionPolicy}).strict();
const definition={policyKey:guestHubIdentityDocumentPolicyKey,parsePolicy:(raw:unknown)=>guestHubIdentityDocumentPolicySchema.parse(raw),assertPolicy:effectiveGuestHubIdentityDocumentPolicy,AccessError:GuestHubIdentityDocumentAccessError};
export function guestHubIdentityDocumentSettings(tx:TenantTransaction,organizationId:string,source:GuestHubNativeSource,now:Date){return guestHubFormSettings(tx,organizationId,source,now,definition);}

export function createGuestHubIdentityDocumentGrantService(documents:GuestHubIdentityDocumentAuthorityProvider){
 return createGuestHubFormGrantService({formKey:"IDENTITY_DOCUMENTS",resourceType:"guest_hub_identity_documents",reviewProtocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_GRANT_REVIEW_V1",settings:guestHubIdentityDocumentSettings,AccessError:GuestHubIdentityDocumentAccessError,ConflictError:GuestHubIdentityDocumentConflictError,extension:{
  async context(actor,tx,source,now,settings){
   const policy=guestHubIdentityDocumentPolicySchema.parse(settings.snapshot.value),captured=policies.parse(await documents.capture(actor,tx,source,now,policy));
   if(captured.archivePolicy.organizationId!==actor.organizationId||captured.retentionPolicy.organizationId!==actor.organizationId)throw new GuestHubIdentityDocumentAccessError();
   intersectGuestHubIdentityDocumentArchivePolicies(policy,policy,captured.archivePolicy,captured.retentionPolicy,captured.archivePolicy,captured.retentionPolicy);
   return{snapshot:JSON.parse(JSON.stringify(captured)) as Prisma.InputJsonObject,policyIds:[captured.archivePolicy.id,captured.retentionPolicy.id],fingerprint:jsonbFingerprint({authorizationCap:captureAuthorizationCap(actor.authContext),policies:captured})};
  },
  async record(actor,tx,grant,extension,deps){
   const captured=policies.parse(extension.snapshot),authenticated=authenticateGuestHubFormGrant(grant,deps.env??process.env,GuestHubIdentityDocumentAccessError),binding=guestHubIdentityDocumentDelegationBindingSchema.parse({protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_DELEGATION_V1",organizationId:actor.organizationId,grantId:grant.id,grantFingerprint:authenticated.fingerprint,createdBy:grant.createdBy,authorizationCap:grant.authorizationCap,...captured}),signed=signGuestHubIdentityDocumentDelegation(binding,deps.env);
   let signature:string;try{signature=signed.signature.toString("hex");}finally{signed.signature.fill(0);}
   await new GuestHubIdentityDocumentRepository(tx,actor.organizationId).appendDelegation({grantId:grant.id,archivePolicyId:captured.archivePolicy.id,archivePolicyVersion:captured.archivePolicy.version,archivePolicySnapshot:JSON.parse(JSON.stringify(captured.archivePolicy)) as Prisma.InputJsonObject,retentionPolicyId:captured.retentionPolicy.id,retentionPolicyVersion:captured.retentionPolicy.version,retentionPolicySnapshot:JSON.parse(JSON.stringify(captured.retentionPolicy)) as Prisma.InputJsonObject,signatureVersion:signed.version,signature,createdAt:grant.createdAt});
  }
 }});
}
