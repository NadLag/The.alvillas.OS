import {isDeepStrictEqual} from "node:util";
import {withTenant} from "@/platform/db/tenant";
import {OnboardingOwnerPackageRepository} from "../infrastructure/onboarding-owner-package-repository";
import {OnboardingOwnerDeliveryRepository} from "../infrastructure/onboarding-owner-delivery-repository";
import {OnboardingConflictError} from "../domain/onboarding-wizard";
import {onboardingOwnerDeliveryReceiptSchema} from "../domain/onboarding-owner-delivery";
import {nativeOnboardingActivationOriginal} from "./onboarding-service";
import {reviewOnboardingOwnerPackage,admitOnboardingOwnerPackage,completeOnboardingOwnerPackage,nativeOnboardingOwnerPackageOriginal} from "./onboarding-owner-package-service";
import {reviewOnboardingOwnerDelivery,admitOnboardingOwnerDelivery,nativeOnboardingOwnerDeliveryOriginal} from "./onboarding-owner-delivery-service";

type Dependencies=Parameters<typeof completeOnboardingOwnerPackage>[2];
const packageReason=(id:string)=>"onboarding.activation.documents:"+id,emailReason=(id:string)=>"onboarding.activation.email:"+id;
const context=(organizationId:string,activationId:string,deps:Dependencies)=>withTenant(deps.db,organizationId,tx=>nativeOnboardingActivationOriginal(organizationId,tx,activationId,deps),{timeout:120000});

/** Existing immutable native UUIDs provide separate stable child nonces across every worker attempt. */
export async function admitActivationOwnerPackage(organizationId:string,activationId:string,deps:Dependencies){
 const run=await context(organizationId,activationId,deps),draft={sessionId:run.row.sessionId,reviewRevisionId:run.row.reviewRevisionId},existing=await withTenant(deps.db,organizationId,async tx=>{const row=await new OnboardingOwnerPackageRepository(tx,organizationId).packageByNonce(run.row.id);if(!row)return null;if(row.createdBy!==run.row.createdBy||row.sessionId!==draft.sessionId||row.reviewRevisionId!==draft.reviewRevisionId||row.propertyId!==run.row.propertyId||row.ownerId!==run.row.ownerId)throw new OnboardingConflictError();const saved=await nativeOnboardingOwnerPackageOriginal(run.actor,tx,row.id,deps);if(saved.original.command.reason!==packageReason(run.row.id))throw new OnboardingConflictError();return saved.receipt;},{timeout:120000});
 if(existing){await context(organizationId,activationId,deps);return existing;}const reviewed=await reviewOnboardingOwnerPackage(run.actor,draft,deps),receipt=await admitOnboardingOwnerPackage(run.actor,{...draft,idempotencyKey:run.row.id,reviewFingerprint:reviewed.reviewFingerprint,reason:packageReason(run.row.id)},deps);await context(organizationId,activationId,deps);return receipt;
}
/** Canonical document workers perform all actual rendering/archive I/O; this returns their genuine paired receipt. */
export async function completeActivationOwnerPackage(organizationId:string,activationId:string,deps:Dependencies){
 const pending=await admitActivationOwnerPackage(organizationId,activationId,deps),run=await context(organizationId,activationId,deps),receipt=await completeOnboardingOwnerPackage(run.actor,{packageId:pending.packageId},deps);await context(organizationId,activationId,deps);return receipt;
}
/** Admission queues the existing canonical email worker. It does not call a provider or claim delivery. */
export async function admitActivationOwnerDelivery(organizationId:string,activationId:string,deps:Dependencies){
 const run=await context(organizationId,activationId,deps),packageReceipt=await admitActivationOwnerPackage(organizationId,activationId,deps);if(packageReceipt.state!=="COMPLETE")throw new OnboardingConflictError();const draft={packageId:packageReceipt.packageId},existing=await withTenant(deps.db,organizationId,async tx=>{const row=await new OnboardingOwnerDeliveryRepository(tx,organizationId).byNonce(run.event.id);if(!row)return null;if(row.createdBy!==run.row.createdBy||row.packageId!==packageReceipt.packageId||row.ownerId!==run.row.ownerId||row.propertyId!==run.row.propertyId)throw new OnboardingConflictError();const saved=await nativeOnboardingOwnerDeliveryOriginal(run.actor,tx,row.id,deps);if(saved.original.command.reason!==emailReason(run.row.id))throw new OnboardingConflictError();const actual=saved.delivery;return onboardingOwnerDeliveryReceiptSchema.parse({recorded:true,id:row.id,packageId:row.packageId,idempotencyKey:row.commandKey,requestedAt:row.createdAt.toISOString(),locale:row.locale,deliveryRecordId:actual?.id??null,state:actual?.status??"PENDING",acceptedAt:actual?.acceptedAt?.toISOString()??null,deliveredAt:actual?.deliveredAt?.toISOString()??null,replayed:true});},{timeout:120000});
 if(existing){await context(organizationId,activationId,deps);return existing;}const reviewed=await reviewOnboardingOwnerDelivery(run.actor,draft,deps),receipt=await admitOnboardingOwnerDelivery(run.actor,{...draft,idempotencyKey:run.event.id,reviewFingerprint:reviewed.reviewFingerprint,reason:emailReason(run.row.id)},deps),final=await context(organizationId,activationId,deps);if(!isDeepStrictEqual(final.row.authorizationCap,run.row.authorizationCap))throw new OnboardingConflictError();return receipt;
}
