import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {GuestHubIdentityDocumentAccessError} from "../domain/guest-hub-identity-document-policy";
import {validateGuestHubIdentityDocumentSelection} from "../domain/guest-hub-identity-document-contract";
import {decryptGuestHubIdentityDocumentCapture} from "../domain/guest-hub-identity-document-private";
import {GuestHubIdentityCaptureRepository} from "../infrastructure/guest-hub-identity-capture-repository";
import {guestHubIdentityCaptureBinding} from "./guest-hub-identity-capture-source";
import {activeGuestHubIdentityDocuments} from "./guest-hub-identity-document-source";
import type {GuestHubIdentityDocumentAuthorityProvider} from "./guest-hub-identity-document-grants";
import {guestHubFormCapability} from "./guest-hub-form-visit";
import {createGuestHubCapabilityLease,type GuestHubCapabilityContext,type GuestHubVisitDependencies} from "./guest-hub-visit";

const reference=z.object({captureId:guestHubIdSchema,fileId:guestHubIdSchema}).strict();
/** One HTTP request obtains one budgeted lease. Each canonical document transaction
 * independently rechecks its exact native file, privacy purpose and original grantor. */
async function createGuestHubIdentityFileRequest<Access extends "UPLOAD"|"STATUS">(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies,documents:GuestHubIdentityDocumentAuthorityProvider,access:Access){
 const input=reference.parse(raw),lease=await createGuestHubCapabilityLease(capability,deps,access==="UPLOAD"?async context=>{
  const form=await activeGuestHubIdentityDocuments(context,documents,deps.env),limits=new Map<number,number>();
  for(const limit of form.policy.uploadLimits)limits.set(limit.window_seconds,Math.min(limits.get(limit.window_seconds)??limit.requests,limit.requests));
  let allowed=true;for(const[windowSeconds,limit]of limits){const result=await consumeRateLimit(context.tx,context.actual.row.organizationId,{key:"guest-hub:identity-upload:"+context.actual.row.id,limit,windowSeconds,now:form.now});allowed=result.allowed&&allowed;}return allowed;
 }:undefined);
 let expectedForm:string|undefined;
 async function actualFile(context:GuestHubCapabilityContext){
  const {row}=context.actual,form=await activeGuestHubIdentityDocuments(context,documents,deps.env),repo=new GuestHubIdentityCaptureRepository(context.tx,row.organizationId);
  const formCapability=guestHubFormCapability(context,form,"guest_hub_identity_documents",access==="UPLOAD"?"create":"view",new GuestHubIdentityDocumentAccessError());
  if(expectedForm!==undefined&&form.fingerprint!==expectedForm)throw new GuestHubIdentityDocumentAccessError();
  const capture=await repo.captureById(row.id,input.captureId),latest=await repo.latestCapture(row.reservationId,row.guestId),file=await repo.fileById(input.captureId,input.fileId);
  if(!capture||!file||capture.grantId!==form.grant.id||capture.grantFingerprint!==form.grantFingerprint||capture.reservationId!==row.reservationId||capture.propertyId!==row.propertyId||capture.guestId!==row.guestId||access==="UPLOAD"&&(latest?.id!==capture.id||capture.sourceFingerprint!==form.sourceFingerprint))throw new GuestHubIdentityDocumentAccessError();
  const binding=guestHubIdentityCaptureBinding(capture),payload=decryptGuestHubIdentityDocumentCapture(capture.encryptedPayload,binding,capture.fileManifest,deps.env);
  validateGuestHubIdentityDocumentSelection({previousCaptureId:capture.previousId,files:payload.files,acknowledged:payload.acknowledged},form.policy);
  const item=payload.files.find(item=>item.kind===file.kind&&item.part===file.part),policy=form.policy.documents.find(document=>document.kind===file.kind);
  if(!item||!policy)throw new GuestHubIdentityDocumentAccessError();expectedForm=form.fingerprint;
  return{capture,file,descriptor:item,policy,currentCapture:latest?.id===capture.id,formAuthority:formCapability.authority,formResource:formCapability.resource,now:form.now,documentActor:form.documentActor,archivePolicy:form.archivePolicy,retentionPolicy:form.retentionPolicy,source:context.actual.source,grant:form.grant,delegation:form.delegation,fingerprint:form.fingerprint};
 }
 return Object.freeze({access,organizationId:lease.organizationId,linkId:lease.linkId,captureId:input.captureId,fileId:input.fileId,
  run<T>(tx:TenantTransaction,work:(file:Awaited<ReturnType<typeof actualFile>>)=>Promise<T>){return lease.run(tx,async context=>work(await actualFile(context)),async context=>{await actualFile(context);});}
 });
}
export function createGuestHubIdentityUploadRequest(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies,documents:GuestHubIdentityDocumentAuthorityProvider){return createGuestHubIdentityFileRequest(capability,raw,deps,documents,"UPLOAD");}
/** Metadata recovery keeps the live capability and form fences without spending an upload allowance. */
export function createGuestHubIdentityFileStatusRequest(capability:unknown,raw:unknown,deps:GuestHubVisitDependencies,documents:GuestHubIdentityDocumentAuthorityProvider){return createGuestHubIdentityFileRequest(capability,raw,deps,documents,"STATUS");}
export type GuestHubIdentityUploadRequest=Awaited<ReturnType<typeof createGuestHubIdentityUploadRequest>>;
export type GuestHubIdentityFileStatusRequest=Awaited<ReturnType<typeof createGuestHubIdentityFileStatusRequest>>;
