import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {formatOnboardingOwnerPackage,ownerPackageTextBindings} from "@/modules/onboarding/domain/onboarding-owner-package-format";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {TemplateBindingError,type DocumentTemplateBinding} from "@/modules/documents/domain/document-template";
import {OnboardingDocumentSourceRepository} from "@/modules/onboarding/infrastructure/onboarding-document-source-repository";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "@/modules/onboarding/domain/onboarding-wizard";
import {DocumentAccessError,DocumentConflictError,DocumentConfigurationError} from "@/modules/documents/domain/document-command";
import {ZodError} from "zod";

/** Load the full native application only after metadata selection and document authority; keep source discovery independent. */
export async function nativeOnboardingDocumentBindings(tx:TenantTransaction,organizationId:string,revisionId:string,requested:readonly string[],locale:"en"|"fr"|"ar",env:NodeJS.ProcessEnv|undefined,actor:AccountActorContext){
 try{
 if(actor.organizationId!==organizationId)throw new TemplateBindingError();const head=(await new OnboardingDocumentSourceRepository(tx,organizationId).heads([revisionId]))[0];if(!head||head.ownerArchivedAt||head.propertyArchivedAt)throw new TemplateBindingError();
 const{nativeOnboardingOwnerPackageSource}=await import("@/modules/onboarding/application/onboarding-owner-package-source"),source=await nativeOnboardingOwnerPackageSource(actor,tx,{sessionId:head.sessionId,revisionId},{env}),text=ownerPackageTextBindings(formatOnboardingOwnerPackage(source.report,locale),requested),bindings=new Map<string,DocumentTemplateBinding>();for(const[key,value]of text)bindings.set(key,{kind:"TEXT",value,privacy:["financial","sensitive"]});
 return{bindings:bindings as ReadonlyMap<string,DocumentTemplateBinding>,fingerprint:commandFingerprint({source:source.fingerprint,locale,values:[...text]})};
 }catch(error){
  if(error instanceof OnboardingAccessError)throw new DocumentAccessError();
  if(error instanceof OnboardingConflictError)throw new DocumentConflictError();
  if(error instanceof OnboardingConfigurationError||error instanceof ZodError)throw new DocumentConfigurationError();
  throw error;
 }
}
