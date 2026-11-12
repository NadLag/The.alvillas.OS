import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {onboardingMaximumConfigurationRecordBytes} from "@/platform/onboarding/limits";
import {OnboardingConfigurationError,OnboardingConflictError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {nativeOnboardingActivationOriginal,nativeOnboardingOwnerPackageReviewSource,type OnboardingDependencies} from "./onboarding-service";

/** Shared actual Review/source checks for canonical workflow and task effects. */
export async function nativeOnboardingActivationWorkflowSource(organizationId:string,tx:TenantTransaction,activationId:string,deps:OnboardingDependencies){
 const run=await nativeOnboardingActivationOriginal(organizationId,tx,activationId,deps),native=new OnboardingRepository(tx,organizationId),review=await nativeOnboardingOwnerPackageReviewSource(run.actor,tx,{sessionId:run.row.sessionId,revisionId:run.row.reviewRevisionId},deps),rule=review.validation.facts.workflows?.rules["ops.workflows"],rules=new ConfigRuleRepository(tx,organizationId);if(!rule||!run.actor.authContext.personId)throw new OnboardingConfigurationError();
 const source=await rules.sourceMetadataWitness(rule.id),size=await rules.sourceValueBytes(rule.id);if(!source||source.key!=="ops.workflows"||source.version!==rule.version||source.lifecycle!=="ACTIVE"||source.archivedAt||!source.createdBy||size===null||!Number.isSafeInteger(size)||size<0||size>onboardingMaximumConfigurationRecordBytes)throw new OnboardingConfigurationError();const original=await rules.sourceWitness(source.id);if(!original||original.xmin!==source.xmin||original.tuple!==source.tuple)throw new OnboardingConflictError();
 return{run,native,review,rules,source,original};
}
export async function recheckOnboardingActivationWorkflowSource(organizationId:string,tx:TenantTransaction,activationId:string,before:Awaited<ReturnType<typeof nativeOnboardingActivationWorkflowSource>>,deps:OnboardingDependencies){
 const final=await nativeOnboardingActivationOriginal(organizationId,tx,activationId,deps),selected=await nativeOnboardingOwnerPackageReviewSource(final.actor,tx,{sessionId:before.run.row.sessionId,revisionId:before.run.row.reviewRevisionId},deps),latest=await before.rules.sourceMetadataWitness(before.source.id);if(selected.fingerprint!==before.review.fingerprint||selected.validation.facts.workflows?.rules["ops.workflows"]?.id!==before.source.id||!latest||latest.xmin!==before.source.xmin||latest.tuple!==before.source.tuple)throw new OnboardingConflictError();
}
