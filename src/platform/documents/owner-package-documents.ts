import type {TenantTransaction} from "@/platform/db/tenant";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {documentGenerationSnapshotSchema} from "@/modules/documents/domain/document-generation";
import {DocumentAccessError,DocumentConflictError,DocumentConfigurationError,DocumentRateLimitError} from "@/modules/documents/domain/document-command";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError,OnboardingRateLimitError} from "@/modules/onboarding/domain/onboarding-wizard";

/** This platform contract owns cross-module calls; canonical document admission, authorization and workers remain authoritative. */
export {documentActorContext as ownerPackageDocumentActor,documentJson as ownerPackageDocumentJson} from "@/modules/documents/application/document-archive";
export {prepareDocumentGeneration as prepareOwnerPackageDocument} from "@/modules/documents/application/document-generation-review";
export {admitDocumentGeneration as admitOwnerPackageDocument,documentGenerationResult as ownerPackageDocumentResult} from "@/modules/documents/application/document-generation-admission";
export {publishDocumentGeneration as publishOwnerPackageDocument} from "@/modules/documents/application/document-generation-publication";

/** No repository or caller-supplied document state crosses the platform contract. */
export async function readOwnerPackageDocument(tx:TenantTransaction,organizationId:string,instanceId:string){
 const instance=await new DocumentRepository(tx,organizationId).instance(instanceId);
 return instance?{...instance,snapshot:documentGenerationSnapshotSchema.parse(instance.sourceSnapshot)}:null;
}
export async function withOwnerPackageDocuments<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  if(error instanceof DocumentAccessError)throw new OnboardingAccessError();
  if(error instanceof DocumentConflictError)throw new OnboardingConflictError();
  if(error instanceof DocumentConfigurationError)throw new OnboardingConfigurationError();
  if(error instanceof DocumentRateLimitError)throw new OnboardingRateLimitError(error.resetAt);
  throw error;
 }
}
