import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ZodError} from "zod";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {documentActorContext,documentSourceContext,documentAuthorityChecks} from "@/modules/documents/application/document-archive";
import {documentRetentionPolicyKey,documentRetentionPolicySchema} from "@/modules/documents/domain/document-retention-policy";
import {DocumentAccessError,DocumentConfigurationError,DocumentConflictError} from "@/modules/documents/domain/document-command";
import {intersectGuestHubIdentityDocumentArchivePolicies} from "@/modules/guest-hub/domain/guest-hub-identity-document-archive";
import {GuestHubIdentityDocumentAccessError} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";
import type {GuestHubIdentityDocumentAuthorityProvider} from "@/modules/guest-hub/application/guest-hub-identity-document-grants";

/** Composition of the existing document source, archive and retention authorities; no provider or collection enablement. */
export const nativeGuestIdentityDocumentAuthority:GuestHubIdentityDocumentAuthorityProvider={
 async capture(actor,tx,source,_now,policy){
  try{
  const ctx=documentActorContext(actor),current=await documentSourceContext(ctx,tx,{kind:"RESERVATION",id:source.reservationId},"create");
  if(current.native.archived||current.native.resource.propertyId!==source.propertyId)throw new GuestHubIdentityDocumentAccessError();
  const rule=await new ConfigRuleRepository(tx,actor.organizationId).resolve({key:documentRetentionPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:current.now}),retention=documentRetentionPolicySchema.safeParse(rule?.value);
  if(!rule||!retention.success)throw new GuestHubIdentityDocumentAccessError();
  const archivePolicy={organizationId:actor.organizationId,...current.policy},retentionPolicy={organizationId:actor.organizationId,id:rule.id,version:rule.version,value:retention.data};
  const effective=intersectGuestHubIdentityDocumentArchivePolicies(policy,policy,archivePolicy,retentionPolicy,archivePolicy,retentionPolicy);
  for(const document of effective.documents){
   const root={kind:"FILE" as const,createdBy:actor.actorId},checks=[...documentAuthorityChecks(current.native,document.privacy,"create",root),...documentAuthorityChecks(current.native,document.privacy,"edit",root)];
   await recheckAccountAuthorization(ctx,tx,current.now,checks,new GuestHubIdentityDocumentAccessError());
  }
  return{archivePolicy,retentionPolicy};
  }catch(error){if(error instanceof DocumentAccessError||error instanceof DocumentConfigurationError||error instanceof DocumentConflictError||error instanceof ZodError)throw new GuestHubIdentityDocumentAccessError();throw error;}
 }
};
