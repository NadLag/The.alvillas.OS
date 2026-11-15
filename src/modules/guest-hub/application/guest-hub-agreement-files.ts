import {randomUUID} from "node:crypto";
import {withTenant} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {createGuestHubCapabilityLease} from "./guest-hub-visit";
import {guestHubFormCapability} from "./guest-hub-form-visit";
import {activeGuestHubAgreement} from "./guest-hub-agreement-source";
import type {GuestHubAgreementVisitDependencies} from "./guest-hub-agreement-requests";
import {GuestHubAgreementAccessError} from "../domain/guest-hub-agreement-policy";
import {guestHubAgreementProgress} from "../domain/guest-hub-agreement-progress";
import {guestHubAgreementFileInputSchema} from "../domain/guest-hub-agreement-contract";

/** A request-scoped file lease retains no capability, private document or
 * authority in browser storage. All object I/O occurs between transactions. */
export async function createGuestHubAgreementFileLease(capability:unknown,raw:unknown,deps:GuestHubAgreementVisitDependencies){
 const input=guestHubAgreementFileInputSchema.parse(raw),lease=await createGuestHubCapabilityLease(capability,deps);let expected:string|undefined,expectedVersion:string|undefined;
 async function inspect(recordRead=false){return withTenant(deps.db,lease.organizationId,tx=>lease.run(tx,async context=>{
  const form=await activeGuestHubAgreement(context,deps.agreementDocuments,deps.env);guestHubFormCapability(context,form,"guest_hub_agreement","view",new GuestHubAgreementAccessError());
  const existing=await form.repository.requestForPreparation(form.authority.preparationId);if(existing&&(existing.releaseId!==form.release.id||existing.releaseFingerprint!==form.releaseFingerprint))throw new GuestHubAgreementAccessError();
  let versionId:string|null=form.original.document.versionId;
  if(input.kind!=="ORIGINAL"){
   const native=await deps.agreementDocuments.status(form.actor,tx,form.original,form.authority.preparationId,deps.env),progress=guestHubAgreementProgress(form.original,native,existing?"CURRENT":"NONE");if(!progress.complete)throw new GuestHubAgreementAccessError();versionId=input.kind==="SIGNED_ORIGINAL"?native.signedVersionId:native.certificateVersionId;
  }
  if(!versionId||expected&&expected!==form.fingerprint||expectedVersion&&expectedVersion!==versionId)throw new GuestHubAgreementAccessError();expected=form.fingerprint;expectedVersion=versionId;
  if(recordRead)await writeAuditEvent(tx,{organizationId:lease.organizationId,actorId:null,action:"guest_hub.agreement_file_read",resourceType:"guest_hub_agreement",resourceId:form.release.id,propertyScopeId:context.actual.row.propertyId,after:{linkId:context.actual.row.id,reservationId:context.actual.row.reservationId,kind:input.kind,versionId},requestId:deps.requestId??randomUUID(),occurredAt:await context.actual.repository.clock()});
  const final=await activeGuestHubAgreement(context,deps.agreementDocuments,deps.env);if(final.fingerprint!==expected)throw new GuestHubAgreementAccessError();
  return{actor:form.actor,versionId,kind:input.kind,original:form.original};
 }));}
 return Object.freeze({inspect,recordRead:()=>inspect(true)});
}
