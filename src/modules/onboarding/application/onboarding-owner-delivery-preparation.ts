import {isDeepStrictEqual} from "node:util";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {onboardingMaximumConfigurationRecordBytes} from "@/platform/onboarding/limits";
import {nativeOnboardingOwnerWitness} from "@/platform/onboarding/owner-source";
import {ownerPackageDocumentActor,withOwnerPackageDocuments} from "@/platform/documents/owner-package-documents";
import {renderOnboardingOwnerPackageEmails} from "@/platform/email/onboarding-owner-package";
import {OnboardingOwnerPackageRepository} from "../infrastructure/onboarding-owner-package-repository";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {onboardingOwnerPackageSourceSchema} from "../domain/onboarding-owner-package-run";
import {onboardingOwnerDeliveryDraftSchema,buildOnboardingOwnerDeliverySource,onboardingOwnerDeliveryProtocol} from "../domain/onboarding-owner-delivery";
import {onboardingOwnerDeliveryPolicyKey,onboardingOwnerDeliveryPolicySchema} from "../domain/onboarding-owner-delivery-policy";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "../domain/onboarding-wizard";
import {nativeOnboardingOwnerPackageOriginal} from "./onboarding-owner-package-service";
import {nativeOnboardingOwnerPackageSource} from "./onboarding-owner-package-source";
import {nativeOnboardingOwnerPackageHistoryAuthority} from "./onboarding-service";

type Dependencies={db:TenantTransactionRunner;env?:NodeJS.ProcessEnv;requestId?:string};
/** Internal native preparation. Caller input contains only a package reference; no recipient, language, report values or delivery status. */
export async function prepareOnboardingOwnerDelivery(actor:AccountActorContext,raw:unknown,deps:Dependencies){return withOwnerPackageDocuments(async()=>{
 const ctx=ownerPackageDocumentActor(actor),input=onboardingOwnerDeliveryDraftSchema.parse(raw),parent=await withTenant(deps.db,ctx.organizationId,async tx=>{
  const row=await new OnboardingOwnerPackageRepository(tx,ctx.organizationId).packageById(input.packageId);if(!row||row.createdBy!==ctx.actorId)throw new OnboardingAccessError();
  await nativeOnboardingOwnerPackageHistoryAuthority(ctx,tx,{sessionId:row.sessionId,reviewRevisionId:row.reviewRevisionId});return row;
 });
 const recovered=await withTenant(deps.db,ctx.organizationId,tx=>nativeOnboardingOwnerPackageOriginal(ctx,tx,parent.id,deps));
 if(recovered.receipt.state!=="COMPLETE")throw new OnboardingConflictError();
 const original=onboardingOwnerPackageSourceSchema.parse(parent.sourceSnapshot),receipt=recovered.receipt;
 return withTenant(deps.db,ctx.organizationId,async tx=>{
  const native=await nativeOnboardingOwnerPackageSource(ctx,tx,{sessionId:parent.sessionId,revisionId:parent.reviewRevisionId},deps);
  if(native.fingerprint!==original.nativePackageFingerprint)throw new OnboardingConflictError();
  const owner=await nativeOnboardingOwnerWitness(tx,ctx.organizationId,parent.ownerId);if(!owner||owner.archivedAt)throw new OnboardingConflictError();
  const repository=new ConfigRuleRepository(tx,ctx.organizationId),clock=new OnboardingRepository(tx,ctx.organizationId),now=await clock.clock(),scopes=await new ReservationConfigScopeRepository(tx,ctx.organizationId).scopes({propertyId:parent.propertyId,ownerId:parent.ownerId,asOf:now}),selected=await repository.resolveMetadata({key:onboardingOwnerDeliveryPolicyKey,scopes,asOf:now}),metadata=selected?await repository.sourceMetadataWitness(selected.id):null;
  if(!selected||!metadata||!metadata.createdBy||metadata.lifecycle!=="ACTIVE"||metadata.archivedAt||metadata.key!==onboardingOwnerDeliveryPolicyKey||metadata.version!==selected.version||metadata.scopeType!==selected.scopeType||metadata.scopeId!==selected.scopeId||metadata.scopeType==="agreement"&&metadata.scopeId!==native.report.financialAgreement.id)throw new OnboardingConfigurationError();
  const scope={organizationId:ctx.organizationId,propertyId:parent.propertyId,ownerId:parent.ownerId,city:native.report.property.details.cityId,region:native.report.property.details.regionId},checks:CurrentAuthorityCheck[]=(["view","export"]as const).flatMap(action=>[{action,resource:{...scope,type:"config_rule",id:metadata.key,status:metadata.lifecycle,occurredAt:metadata.createdAt}},{action,resource:{...scope,type:"config_rule",id:metadata.id,status:metadata.lifecycle,occurredAt:metadata.createdAt}}]);
  await recheckAccountAuthorization(ctx,tx,await clock.clock(),checks,new OnboardingAccessError());
  const bytes=await repository.sourceValueBytes(metadata.id);if(bytes===null||!Number.isSafeInteger(bytes)||bytes<0||bytes>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();
  const value=await repository.sourceWitness(metadata.id);if(!value||value.xmin!==metadata.xmin||value.tuple!==metadata.tuple)throw new OnboardingConflictError();
  const policy=onboardingOwnerDeliveryPolicySchema.safeParse(value.value);if(!policy.success)throw new OnboardingConfigurationError();
  const source=buildOnboardingOwnerDeliverySource(native.report,receipt,policy.data,native.fingerprint),emails=renderOnboardingOwnerPackageEmails(source),policySnapshot={id:metadata.id,version:metadata.version,value:policy.data};
  await recheckAccountAuthorization(ctx,tx,await clock.clock(),checks,new OnboardingAccessError());
  const finalNative=await nativeOnboardingOwnerPackageSource(ctx,tx,{sessionId:parent.sessionId,revisionId:parent.reviewRevisionId},deps),finalSelected=await repository.resolveMetadata({key:onboardingOwnerDeliveryPolicyKey,scopes:await new ReservationConfigScopeRepository(tx,ctx.organizationId).scopes({propertyId:parent.propertyId,ownerId:parent.ownerId,asOf:await clock.clock()}),asOf:await clock.clock()}),final=await repository.sourceMetadataWitness(metadata.id);
  const finalOwner=await nativeOnboardingOwnerWitness(tx,ctx.organizationId,parent.ownerId);
  if(finalNative.fingerprint!==native.fingerprint||finalSelected?.id!==metadata.id||!final||final.xmin!==metadata.xmin||final.tuple!==metadata.tuple||!isDeepStrictEqual(finalOwner,owner))throw new OnboardingConflictError();
  const authorizationCap=captureAuthorizationCap(ctx.authContext),reviewFingerprint=commandFingerprint({protocol:onboardingOwnerDeliveryProtocol,actorId:ctx.actorId,packageId:parent.id,policySnapshot,authorizationCap,emailFingerprint:emails.fingerprint});
  return{source,emails,policySnapshot,authorizationCap,reviewFingerprint,package:receipt,owner};
 });
});}
