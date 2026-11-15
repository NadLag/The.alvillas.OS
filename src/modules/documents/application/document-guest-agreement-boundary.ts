import type {SignatureProviderIntent} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {DocumentAccessError} from "../domain/document-command";
import type {NativeGuestAgreementDistributionProvenance} from "../domain/document-guest-agreement-distribution";
import type {storedSignatureDistributionCommandSchema} from "../domain/document-signature-distribution";
import type {DocumentActorContext} from "./document-archive";

/** The native application composition authenticates the retained guest request
 * and rechecks its live original release inside every document transaction. */
export type NativeGuestAgreementSignatureBoundary={
 provenance:NativeGuestAgreementDistributionProvenance;
 prepareAdmission(actor:DocumentActorContext,tx:TenantTransaction):Promise<void>;
 recordAdmission(actor:DocumentActorContext,tx:TenantTransaction,intent:SignatureProviderIntent,requestId:string):Promise<void>;
 assertOriginal(actor:DocumentActorContext,tx:TenantTransaction,intent:SignatureProviderIntent):Promise<void>;
 assertAdmission(actor:DocumentActorContext,tx:TenantTransaction,intent:SignatureProviderIntent):Promise<void>;
};
export function requireNativeGuestAgreementDistributionBoundary(actor:DocumentActorContext,command:ReturnType<typeof storedSignatureDistributionCommandSchema.parse>,boundary:NativeGuestAgreementSignatureBoundary|undefined){
 if(!("guestAgreement"in command)){if(boundary)throw new DocumentAccessError();return null;}
 if(!boundary||jsonbFingerprint(command.guestAgreement)!==jsonbFingerprint(boundary.provenance)||command.guestAgreement.organizationId!==actor.organizationId||command.guestAgreement.delegatedBy!==actor.actorId)throw new DocumentAccessError();return boundary;
}
export async function assertNativeGuestAgreementDistribution(actor:DocumentActorContext,tx:TenantTransaction,command:ReturnType<typeof storedSignatureDistributionCommandSchema.parse>,boundary:NativeGuestAgreementSignatureBoundary|undefined,intent?:SignatureProviderIntent){
 if(!requireNativeGuestAgreementDistributionBoundary(actor,command,boundary))return;
 if(!boundary)throw new DocumentAccessError();
 if(intent)await boundary.assertAdmission(actor,tx,intent);else await boundary.prepareAdmission(actor,tx);
}
