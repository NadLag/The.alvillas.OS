import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {ownerPackageDocumentActor,withOwnerPackageDocuments} from "@/platform/documents/owner-package-documents";
import {onboardingReadinessInputSchema,buildOnboardingReadiness} from "../domain/onboarding-readiness";
import {onboardingOwnerDeliveryReceiptSchema} from "../domain/onboarding-owner-delivery";
import {OnboardingAccessError,OnboardingConflictError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {OnboardingOwnerPackageRepository} from "../infrastructure/onboarding-owner-package-repository";
import {OnboardingOwnerDeliveryRepository} from "../infrastructure/onboarding-owner-delivery-repository";
import {nativeOnboardingOwnerPackageOriginal} from "./onboarding-owner-package-service";
import {nativeOnboardingOwnerDeliveryOriginal} from "./onboarding-owner-delivery-service";
import {nativeOnboardingOwnerPackageHistoryAuthority,nativeOnboardingOwnerPackageReviewSource,nativeOnboardingActivationEvidence,spendNativeOnboardingRead} from "./onboarding-service";

type Dependencies={db:TenantTransactionRunner;env?:NodeJS.ProcessEnv;requestId?:string};
type Input=ReturnType<typeof onboardingReadinessInputSchema.parse>;
async function evidence(actor:AccountActorContext,tx:TenantTransaction,input:Input,deps:Dependencies){
 const scope=await nativeOnboardingOwnerPackageHistoryAuthority(actor,tx,{sessionId:input.sessionId,reviewRevisionId:input.reviewRevisionId}),parent=await new OnboardingOwnerPackageRepository(tx,actor.organizationId).packageById(input.packageId);
 if(!parent||parent.createdBy!==actor.actorId||parent.sessionId!==scope.sessionId||parent.reviewRevisionId!==input.reviewRevisionId||parent.propertyId!==scope.propertyId||parent.ownerId!==scope.ownerId)throw new OnboardingAccessError();
 if(input.ownerDeliveryId){const selected=await new OnboardingOwnerDeliveryRepository(tx,actor.organizationId).byId(input.ownerDeliveryId);if(!selected||selected.createdBy!==actor.actorId||selected.packageId!==parent.id)throw new OnboardingAccessError();}
 let configuration:"CURRENT"|"SOURCE_CHANGED"="CURRENT";try{await nativeOnboardingOwnerPackageReviewSource(actor,tx,{sessionId:input.sessionId,revisionId:input.reviewRevisionId},deps);}catch(error){if(error instanceof OnboardingConflictError)configuration="SOURCE_CHANGED";else throw error;}
 const saved=await nativeOnboardingOwnerPackageOriginal(actor,tx,input.packageId,deps);
 let delivery=null;if(input.ownerDeliveryId){const original=await nativeOnboardingOwnerDeliveryOriginal(actor,tx,input.ownerDeliveryId,deps);if(original.row.packageId!==saved.row.id)throw new OnboardingAccessError();const row=original.row,actual=original.delivery;delivery=onboardingOwnerDeliveryReceiptSchema.parse({recorded:true,id:row.id,packageId:row.packageId,idempotencyKey:row.commandKey,requestedAt:row.createdAt.toISOString(),locale:row.locale,deliveryRecordId:actual?.id??null,state:actual?.status??"PENDING",acceptedAt:actual?.acceptedAt?.toISOString()??null,deliveredAt:actual?.deliveredAt?.toISOString()??null,replayed:true});}
 const activation=await nativeOnboardingActivationEvidence(actor,tx,{sessionId:input.sessionId,reviewRevisionId:input.reviewRevisionId},deps);
 return buildOnboardingReadiness({sessionId:input.sessionId,reviewRevisionId:input.reviewRevisionId,propertyId:saved.row.propertyId,package:saved.receipt,delivery,activation:activation?.receipt??null,configuration,operational:activation?.operational??false});
}
/** Metadata-only checklist; independent original scope/export authority precedes private history access. */
export async function readOnboardingReadiness(actor:AccountActorContext,raw:unknown,deps:Dependencies){return withOwnerPackageDocuments(async()=>{
 const ctx=ownerPackageDocumentActor(actor),input=onboardingReadinessInputSchema.parse(raw);await withTenant(deps.db,ctx.organizationId,tx=>nativeOnboardingOwnerPackageHistoryAuthority(ctx,tx,{sessionId:input.sessionId,reviewRevisionId:input.reviewRevisionId}));await spendNativeOnboardingRead(ctx,deps,input.sessionId);
 return withTenant(deps.db,ctx.organizationId,async tx=>{const before=await evidence(ctx,tx,input,deps);await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"onboarding.readiness_read",resourceType:"onboarding",resourceId:input.sessionId,propertyScopeId:before.propertyId,after:{reviewRevisionId:input.reviewRevisionId,packageId:input.packageId,ownerDeliveryId:input.ownerDeliveryId??null,checks:before.checks,ready:before.ready},requestId:deps.requestId??randomUUID(),occurredAt:await new OnboardingRepository(tx,ctx.organizationId).clock()});const after=await evidence(ctx,tx,input,deps);if(!isDeepStrictEqual(before,after))throw new OnboardingConflictError();return after;},{timeout:120000});
});}
