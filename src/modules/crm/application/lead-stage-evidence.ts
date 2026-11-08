import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {readDocumentHistory} from "@/modules/documents/application/document-archive";
import {readNativeSignatureHistory} from "@/modules/documents/application/document-signature-history";
import {documentSourceReferenceSchema} from "@/modules/documents/domain/document-command";
import {documentEffectiveHistoryFormat} from "@/modules/documents/domain/document-effective-version";
import {documentEffectiveHistorySchema} from "@/modules/documents/domain/document-read-model";
import {LeadStageRepository} from "../infrastructure/lead-stage-repository";
import {LeadPipelineEvidenceError,leadPipelineEvidenceKinds,requireNativeLeadStageProofs,type LeadStageDraft,type LeadPipelinePolicy,type NativeLeadStageProof,type LeadPipelineEvidenceKind} from "../domain/lead-pipeline";

/** Reuse complete canonical document/signature reads in the actual stage transaction. */
export async function nativeLeadStageEvidence(actor:AccountActorContext,tx:TenantTransaction,input:LeadStageDraft,required:readonly LeadPipelineEvidenceKind[],policy:LeadPipelinePolicy,now:Date,deps:{env?:NodeJS.ProcessEnv;requestId?:string}){
  const references=input.evidenceReferences??[];
  if(references.length!==required.length||references.some(reference=>!required.includes(reference.kind)))throw new LeadPipelineEvidenceError();
  if(!required.length)return[];
  // Until the native lead source is registered by proposal/contract work, archive access stays denied.
  const source=documentSourceReferenceSchema.safeParse({kind:"LEAD",id:input.leadId});if(!source.success)throw new LeadPipelineEvidenceError();
  const repository=new LeadStageRepository(tx,actor.organizationId),runner:TenantTransactionRunner={$transaction:work=>work(tx)};
  const proofs:NativeLeadStageProof[]=[];
  let contractVersionId:string|undefined,signatureId:string|undefined;
  for(const kind of leadPipelineEvidenceKinds.filter(kind=>required.includes(kind))){
    const reference=references.find(value=>value.kind===kind);if(!reference)throw new LeadPipelineEvidenceError();
    if(kind==="PROPOSAL_VERSION"||kind==="CONTRACT_VERSION"){
      const row=await repository.proofVersion(reference.sourceId);
      if(!row||row.document.sourceKind!==source.data.kind||row.document.sourceId!==input.leadId||row.document.kind!=="INSTANCE"||row.document.archivedAt||row.admission.contentType!=="application/pdf"||!policy.document_types[kind==="PROPOSAL_VERSION"?"proposal":"contract"].includes(row.document.typeKey))throw new LeadPipelineEvidenceError();
      const history=documentEffectiveHistorySchema.parse(await readDocumentHistory(actor,{documentId:row.documentId,format:documentEffectiveHistoryFormat},{...deps,db:runner}));
      if(history.effectiveVersion?.id!==row.id)throw new LeadPipelineEvidenceError();
      if(kind==="CONTRACT_VERSION")contractVersionId=row.id;
      proofs.push({kind,organizationId:actor.organizationId,leadId:input.leadId,sourceId:row.id,sourceFingerprint:commandFingerprint({documentId:row.documentId,versionId:row.id,revision:row.document.revision.toString(),sha256:row.admission.sha256,cipherSha256:row.cipherSha256,effectiveVersionId:history.effectiveVersion.id,privacy:history.document.privacy}),occurredAt:row.createdAt.toISOString()});
    }else if(kind==="SIGNATURE_SENT"||kind==="SIGNATURE_VIEWED"){
      const event=await repository.proofSignatureEvent(reference.sourceId);
      if(!event?.providerEvidenceId||event.state!==(kind==="SIGNATURE_SENT"?"SENT":"VIEWED")||signatureId&&signatureId!==event.signatureId)throw new LeadPipelineEvidenceError();
      const history=await readNativeSignatureHistory(actor,{signatureId:event.signatureId},{...deps,db:runner});
      if(!contractVersionId||history.signature.documentVersionId!==contractVersionId||["DRAFT","DECLINED","EXPIRED"].includes(history.signature.state))throw new LeadPipelineEvidenceError();
      signatureId=event.signatureId;
      proofs.push({kind,organizationId:actor.organizationId,leadId:input.leadId,sourceId:event.id,sourceFingerprint:commandFingerprint({signatureId:event.signatureId,documentVersionId:history.signature.documentVersionId,currentState:history.signature.state,eventId:event.id,eventState:event.state,evidenceHash:event.evidenceHash,providerEvidenceId:event.providerEvidenceId}),occurredAt:event.observedAt.toISOString()});
    }else if(kind==="SIGNATURE_SIGNED_ARCHIVE"){
      const archive=await repository.proofSignedArchive(reference.sourceId);
      if(!archive||!signatureId||archive.signatureId!==signatureId||!archive.evidence[0]||!archive.artifacts.length||archive.artifacts.some(artifact=>!artifact.admission.version))throw new LeadPipelineEvidenceError();
      const history=await readNativeSignatureHistory(actor,{signatureId:archive.signatureId},{...deps,db:runner});
      if(history.signature.state!=="SIGNED"||history.signature.documentVersionId!==contractVersionId)throw new LeadPipelineEvidenceError();
      proofs.push({kind,organizationId:actor.organizationId,leadId:input.leadId,sourceId:archive.id,sourceFingerprint:commandFingerprint({signatureId:archive.signatureId,commandHash:archive.commandHash,completionEvidenceId:archive.completionEvidenceId,signedEvidence:archive.evidence[0],artifacts:[...archive.artifacts].sort((left,right)=>left.kind.localeCompare(right.kind))}),occurredAt:archive.evidence[0].observedAt.toISOString()});
    }else{
      // Conversion and release must come from their native producers, never a caller-supplied completion flag.
      throw new LeadPipelineEvidenceError();
    }
  }
  return requireNativeLeadStageProofs(actor.organizationId,input.leadId,required,proofs,now);
}
