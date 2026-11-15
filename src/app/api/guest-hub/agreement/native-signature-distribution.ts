import {withTenant} from "@/platform/db/tenant";
import {prisma} from "@/platform/db/client";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {retainedGuestHubAgreementDistributionAuthority,liveGuestHubAgreementDistributionAuthority,assertGuestHubAgreementDistributionOrigin,recordGuestHubAgreementDistributionOrigin,readGuestHubAgreementDistributionReference} from "@/modules/guest-hub/application/guest-hub-agreement-distribution-authority";
import type {GuestHubAgreementReleaseDependencies} from "@/modules/guest-hub/application/guest-hub-agreement-releases";
import type {NativeGuestAgreementSignatureBoundary} from "@/modules/documents/application/document-guest-agreement-boundary";
import {nativeGuestAgreementSignatureDistributionCommand,admitNativeGuestAgreementSignatureDistribution} from "@/modules/documents/application/document-signature-distribution";
import {executeSignatureDistributionReference,readNativeGuestAgreementDistributionReference,type SignatureDistributionWorkerDependencies} from "@/modules/documents/application/document-signature-distribution-worker";
import {DocumentAccessError} from "@/modules/documents/domain/document-command";
import {nativeGuestAgreementDocumentAuthority} from "./native-document-authority";

type Dependencies=GuestHubAgreementReleaseDependencies&SignatureDistributionWorkerDependencies;
export async function nativeGuestAgreementSignatureBoundary(organizationId:string,requestId:string,deps:GuestHubAgreementReleaseDependencies):Promise<NativeGuestAgreementSignatureBoundary>{
 const initial=await withTenant(deps.db,organizationId,tx=>retainedGuestHubAgreementDistributionAuthority(tx,organizationId,requestId,deps.env));
 const sameActor=(actor:{organizationId:string;actorId:string})=>{if(actor.organizationId!==organizationId||actor.actorId!==initial.actor.actorId)throw new DocumentAccessError();};
 return{provenance:initial.provenance,
  async prepareAdmission(actor,tx){sameActor(actor);const current=await liveGuestHubAgreementDistributionAuthority(tx,organizationId,requestId,deps);if(jsonbFingerprint(current.provenance)!==jsonbFingerprint(initial.provenance))throw new DocumentAccessError();},
  async recordAdmission(actor,tx,intent,correlationId){sameActor(actor);await recordGuestHubAgreementDistributionOrigin(tx,organizationId,requestId,intent,deps,correlationId);},
  async assertOriginal(actor,tx,intent){sameActor(actor);const current=await assertGuestHubAgreementDistributionOrigin(tx,organizationId,requestId,intent,deps.env);if(jsonbFingerprint(current.provenance)!==jsonbFingerprint(initial.provenance))throw new DocumentAccessError();},
  async assertAdmission(actor,tx,intent){sameActor(actor);await assertGuestHubAgreementDistributionOrigin(tx,organizationId,requestId,intent,deps.env);await liveGuestHubAgreementDistributionAuthority(tx,organizationId,requestId,deps);}
 };
}
/** The parent outbox only admits the canonical child. Native distribution owns
 * the single provider attempt and its existing uncertain-outcome recovery. */
export async function admitGuestAgreementSignatureReference(raw:unknown,deps:Dependencies={db:prisma,agreementDocuments:nativeGuestAgreementDocumentAuthority}){
 const current=await readGuestHubAgreementDistributionReference(raw,deps);if(current.origin)return{distributionIntentId:current.origin.distributionIntentId,guestRequestId:current.guestRequestId};
 const boundary=await nativeGuestAgreementSignatureBoundary(current.organizationId,current.guestRequestId,deps),native={...deps,nativeGuestAgreement:boundary},command=await nativeGuestAgreementSignatureDistributionCommand(current.actor,native),receipt=await admitNativeGuestAgreementSignatureDistribution(current.actor,command,native);return{distributionIntentId:receipt.id,guestRequestId:current.guestRequestId};
}
/** Both ordinary and guest-origin document events pass the same worker; only
 * authenticated guest provenance selects this additional composition boundary. */
export async function executeComposedSignatureDistributionReference(raw:unknown,deps:SignatureDistributionWorkerDependencies={}){
 const db=deps.db??prisma,provenance=await readNativeGuestAgreementDistributionReference(raw,{db});if(!provenance)return executeSignatureDistributionReference(raw,deps);
 const boundary=await nativeGuestAgreementSignatureBoundary(provenance.organizationId,provenance.guestRequestId,{...deps,db,agreementDocuments:nativeGuestAgreementDocumentAuthority});if(jsonbFingerprint(boundary.provenance)!==jsonbFingerprint(provenance))throw new DocumentAccessError();return executeSignatureDistributionReference(raw,{...deps,db,nativeGuestAgreement:boundary});
}
