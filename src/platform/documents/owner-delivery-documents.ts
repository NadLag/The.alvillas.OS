import type {z} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {onboardingOwnerPackageReceiptSchema} from "@/modules/onboarding/domain/onboarding-owner-package-run";
import {onboardingOwnerDeliveryDocumentPlanSchema} from "@/modules/onboarding/domain/onboarding-owner-delivery-original";
import {OnboardingAccessError,OnboardingConflictError} from "@/modules/onboarding/domain/onboarding-wizard";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {documentActorContext,documentArchiveContext,downloadDocumentVersion} from "@/modules/documents/application/document-archive";
import {documentGenerationSnapshotSchema} from "@/modules/documents/domain/document-generation";
import {documentSourceReferenceSchema} from "@/modules/documents/domain/document-command";
import {withOwnerPackageDocuments} from "./owner-package-documents";

/** Metadata-only attachment selection uses actual canonical version lineage and current plus original document export authority. */
export async function readOwnerDeliveryDocumentPlan(actor:AccountActorContext,tx:TenantTransaction,receipt:z.infer<typeof onboardingOwnerPackageReceiptSchema>,env?:NodeJS.ProcessEnv){return withOwnerPackageDocuments(async()=>{
 const ctx=documentActorContext(actor);if(receipt.state!=="COMPLETE")throw new OnboardingConflictError();const repository=new DocumentRepository(tx,ctx.organizationId),plan=[];
 for(const item of receipt.documents){
  if(item.state!=="COMPLETE"||!item.versionId)throw new OnboardingConflictError();const instance=await repository.instance(item.instanceId),version=await repository.originalVersionMetadata(item.versionId);
  if(!instance||!version||instance.createdBy!==ctx.actorId||version.documentId!==item.documentId||instance.documentId!==item.documentId||instance.document.locale!==item.locale||instance.document.sourceKind!=="ONBOARDING"||instance.document.sourceId!==receipt.reviewRevisionId||version.admission.contentType!=="application/pdf"||!await repository.versionMatchesInstance(version.id,instance.id))throw new OnboardingAccessError();
  const snapshot=documentGenerationSnapshotSchema.parse(instance.sourceSnapshot),held=documentActorContext({...ctx,authContext:restoreAuthorizationCap(snapshot.authorizationCap)}),source=documentSourceReferenceSchema.parse({kind:"ONBOARDING",id:receipt.reviewRevisionId});
  for(const principal of[ctx,held])await documentArchiveContext(principal,tx,source,"export",instance.document,undefined,env);
  plan.push({locale:item.locale,instanceId:instance.id,documentId:instance.documentId,versionId:version.id,sha256:version.admission.sha256,cipherSha256:version.cipherSha256,byteSize:version.admission.fileSize,contentType:"application/pdf"});
 }
 return onboardingOwnerDeliveryDocumentPlanSchema.parse(plan);
});}

/** Call outside an admission transaction after validating the stored original and its attachment plan. */
export const downloadOwnerDeliveryDocument=downloadDocumentVersion;
