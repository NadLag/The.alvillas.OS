import {readDocumentSourceWorkspace,documentReadCursor,readDocumentCursor} from "@/modules/documents/application/document-workspace";
import {DocumentAccessError,DocumentConflictError} from "@/modules/documents/domain/document-command";
import {LeadAccessError} from "@/modules/crm/domain/lead-capture";
import {LeadPipelineConflictError} from "@/modules/crm/domain/lead-pipeline";
import type {LeadStageEvidenceChoicesInput,LeadStageEvidenceChoices} from "@/modules/crm/domain/lead-stage-evidence-choices";
import {leadStageEvidenceChoicesSchema,type leadStageEvidencePrefix} from "@/modules/crm/domain/lead-stage-evidence-choices";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {readDocumentHistory} from "@/modules/documents/application/document-archive";
import {readNativeSignatureHistory,listNativeSignatures} from "@/modules/documents/application/document-signature-history";
import {documentSourceReferenceSchema} from "@/modules/documents/domain/document-command";
import {documentEffectiveHistoryFormat} from "@/modules/documents/domain/document-effective-version";
import {documentEffectiveHistorySchema} from "@/modules/documents/domain/document-read-model";
import {LeadStageRepository} from "@/modules/crm/infrastructure/lead-stage-repository";
import {LeadConversionRepository} from "@/modules/crm/infrastructure/lead-conversion-repository";
import {nativeLeadOwnerHead} from "@/platform/crm/lead-owner-source";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {LeadPipelineEvidenceError,leadPipelineEvidenceKinds,requireNativeLeadStageProofs,type LeadStageDraft,type LeadPipelinePolicy,type NativeLeadStageProof,type LeadPipelineEvidenceKind} from "@/modules/crm/domain/lead-pipeline";

/** Reuse complete canonical document/signature reads in the actual stage transaction. */
export async function nativeLeadStageEvidence(actor:AccountActorContext,tx:TenantTransaction,input:LeadStageDraft,required:readonly LeadPipelineEvidenceKind[],policy:LeadPipelinePolicy,now:Date,deps:{env?:NodeJS.ProcessEnv;requestId?:string}){
  const references=input.evidenceReferences??[];
  if(references.length!==required.length||references.some(reference=>!required.includes(reference.kind)))throw new LeadPipelineEvidenceError();
  if(!required.length)return[];
  // Only the registered native source can establish document and signature lineage.
  const source=documentSourceReferenceSchema.safeParse({kind:"LEAD",id:input.leadId});if(!source.success)throw new LeadPipelineEvidenceError();
  const repository=new LeadStageRepository(tx,actor.organizationId),runner:TenantTransactionRunner={$transaction:work=>work(tx)};
  const proofs:NativeLeadStageProof[]=[];
  type SignatureEvent=NonNullable<Awaited<ReturnType<LeadStageRepository["proofSignatureEvent"]>>>;
  const signedGroup=required.includes("SIGNATURE_SIGNED_ARCHIVE"),pendingEvents:Array<{kind:"SIGNATURE_SENT"|"SIGNATURE_VIEWED";event:SignatureEvent}>=[];
  const appendEventProof=(kind:"SIGNATURE_SENT"|"SIGNATURE_VIEWED",event:SignatureEvent,history:Awaited<ReturnType<typeof readNativeSignatureHistory>>)=>{
    proofs.push({kind,organizationId:actor.organizationId,leadId:input.leadId,sourceId:event.id,sourceFingerprint:commandFingerprint({signatureId:event.signatureId,documentVersionId:history.signature.documentVersionId,currentState:history.signature.state,eventId:event.id,eventState:event.state,evidenceHash:event.evidenceHash,providerEvidenceId:event.providerEvidenceId}),occurredAt:event.observedAt.toISOString()});
  };
  let contractVersionId:string|undefined,signatureId:string|undefined,signedArchiveId:string|undefined;
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
      if(signedGroup){if(!contractVersionId)throw new LeadPipelineEvidenceError();signatureId=event.signatureId;pendingEvents.push({kind,event});continue;}
      const history=await readNativeSignatureHistory(actor,{signatureId:event.signatureId},{...deps,db:runner});
      if(!contractVersionId||history.signature.documentVersionId!==contractVersionId||["DRAFT","DECLINED","EXPIRED"].includes(history.signature.state))throw new LeadPipelineEvidenceError();
      signatureId=event.signatureId;
      appendEventProof(kind,event,history);
    }else if(kind==="SIGNATURE_SIGNED_ARCHIVE"){
      const archive=await repository.proofSignedArchive(reference.sourceId);
      if(!archive||!signatureId||archive.signatureId!==signatureId||!archive.evidence[0]||!archive.artifacts.length||archive.artifacts.some(artifact=>!artifact.admission.version))throw new LeadPipelineEvidenceError();
      const history=await readNativeSignatureHistory(actor,{signatureId:archive.signatureId},{...deps,db:runner});
      if(history.signature.state!=="SIGNED"||history.signature.documentVersionId!==contractVersionId)throw new LeadPipelineEvidenceError();
      // Publish all immutable event facts against one complete current canonical read, after their source lookups.
      // A caller's post-audit validation invokes this function again and obtains a fresh read.
      for(const pending of pendingEvents)appendEventProof(pending.kind,pending.event,history);
      signedArchiveId=archive.id;
      proofs.push({kind,organizationId:actor.organizationId,leadId:input.leadId,sourceId:archive.id,sourceFingerprint:commandFingerprint({signatureId:archive.signatureId,commandHash:archive.commandHash,completionEvidenceId:archive.completionEvidenceId,signedEvidence:archive.evidence[0],artifacts:[...archive.artifacts].sort((left,right)=>left.kind.localeCompare(right.kind))}),occurredAt:archive.evidence[0].observedAt.toISOString()});
    }else if(kind==="OWNER_CONVERSION"){
      const conversion=await new LeadConversionRepository(tx,actor.organizationId).byId(reference.sourceId);
      if(!conversion||conversion.leadId!==input.leadId||conversion.signedArchiveId!==signedArchiveId)throw new LeadPipelineEvidenceError();
      const owner=await nativeLeadOwnerHead(tx,actor.organizationId,conversion.ownerId);if(!owner)throw new LeadPipelineEvidenceError();
      await recheckAccountAuthorization(actor,tx,await repository.clock(),[{action:"view",resource:{type:"owner",organizationId:actor.organizationId,id:owner.id,ownerId:owner.id,dataClass:"personal",occurredAt:owner.createdAt}}],new LeadPipelineEvidenceError());
      proofs.push({kind,organizationId:actor.organizationId,leadId:input.leadId,sourceId:conversion.id,sourceFingerprint:commandFingerprint({conversionId:conversion.id,ownerId:conversion.ownerId,signedStageId:conversion.signedStageId,signedArchiveId:conversion.signedArchiveId,commandHash:conversion.commandHash,sourceFingerprint:conversion.sourceFingerprint,ownerUpdatedAt:owner.updatedAt.toISOString()}),occurredAt:conversion.createdAt.toISOString()});
    }else{
      // Conversion and release must come from their native producers, never a caller-supplied completion flag.
      throw new LeadPipelineEvidenceError();
    }
  }
  return requireNativeLeadStageProofs(actor.organizationId,input.leadId,required,proofs,now);
}


/** Reuse the registered native document/signature catalogs through the existing module bridge. */
export async function nativeLeadStageEvidenceChoices(actor:AccountActorContext,tx:TenantTransaction,input:LeadStageEvidenceChoicesInput,draft:LeadStageDraft,prefix:ReturnType<typeof leadStageEvidencePrefix>,policy:LeadPipelinePolicy,deps:{env?:NodeJS.ProcessEnv;requestId?:string}){
 const repository=new LeadStageRepository(tx,actor.organizationId),runner:TenantTransactionRunner={$transaction:work=>work(tx)},nativeDeps={...deps,db:runner};
 try{
  const result:LeadStageEvidenceChoices={protocol:"NATIVE_LEAD_STAGE_EVIDENCE_CHOICES_V1",leadId:input.leadId,previousRevisionId:input.previousRevisionId,toStage:input.toStage,...prefix,items:[],next:null,dependency:null},kind=prefix.nextKind;
  // Canonical readers run after the selector audit/fence, in this actual transaction, and retain their source/privacy/expiry publication checks.
  if(kind==="PROPOSAL_VERSION"||kind==="CONTRACT_VERSION"){
   const types=policy.document_types[kind==="PROPOSAL_VERSION"?"proposal":"contract"];
   if(input.documentId){
    if(input.cursor)throw new LeadPipelineEvidenceError();const history=documentEffectiveHistorySchema.parse(await readDocumentHistory(actor,{documentId:input.documentId,format:documentEffectiveHistoryFormat},nativeDeps));
    if(history.document.source.kind!=="LEAD"||history.document.source.id!==input.leadId||history.document.kind!=="INSTANCE"||history.document.archivedAt||!types.includes(history.document.typeKey)||!history.effectiveVersion)throw new LeadPipelineEvidenceError();
    const reference={kind,sourceId:history.effectiveVersion.id},proofs=await nativeLeadStageEvidence(actor,tx,{...draft,evidenceReferences:[...prefix.selected,reference]},[...prefix.selected.map(value=>value.kind),kind],policy,await repository.clock(),deps),proof=proofs.find(value=>value.kind===kind)!;
    result.items=[{kind:"EVIDENCE",id:reference.sourceId,evidenceKind:kind,title:history.document.title,number:history.effectiveVersion.number,occurredAt:proof.occurredAt}];
   }else{
    const workspace=await readDocumentSourceWorkspace(actor,{source:{kind:"LEAD",id:input.leadId},kind:"FILE",...input.cursor?{cursor:input.cursor}:{}},nativeDeps);
    result.items=workspace.items.filter(item=>item.kind==="INSTANCE"&&!item.archivedAt&&types.includes(item.typeKey)).map(item=>({kind:"DOCUMENT"as const,id:item.id,title:item.title,locale:item.locale}));result.next=workspace.next;
   }
  }else if(kind==="SIGNATURE_SENT"&&!input.signatureId){
   const contract=prefix.selected.find(reference=>reference.kind==="CONTRACT_VERSION");if(!contract)throw new LeadPipelineEvidenceError();
   const signatures=await listNativeSignatures(actor,{documentVersionId:contract.sourceId,...input.cursor?{cursor:input.cursor}:{}},nativeDeps);
   result.items=signatures.items.filter(item=>["SENT","VIEWED","SIGNED"].includes(item.state)).map(item=>({kind:"SIGNATURE"as const,id:item.id,state:item.state,createdAt:item.requestedAt}));result.next=signatures.next;
  }else if(kind==="SIGNATURE_SENT"||kind==="SIGNATURE_VIEWED"){
   const sent=prefix.selected.find(reference=>reference.kind==="SIGNATURE_SENT"),signatureId=input.signatureId??(sent?await repository.proofSignatureEvent(sent.sourceId):null)?.signatureId;if(!signatureId)throw new LeadPipelineEvidenceError();
   const history=await readNativeSignatureHistory(actor,{signatureId,...input.cursor?{cursor:input.cursor}:{}},nativeDeps),contract=prefix.selected.find(reference=>reference.kind==="CONTRACT_VERSION");if(history.signature.documentVersionId!==contract?.sourceId||["DRAFT","DECLINED","EXPIRED"].includes(history.signature.state))throw new LeadPipelineEvidenceError();
   const events=history.events.filter(event=>event.state===(kind==="SIGNATURE_SENT"?"SENT":"VIEWED")),providerIds=new Set((await repository.providerEvents(events.map(event=>event.id))).map(event=>event.id));
   result.items=events.filter(event=>providerIds.has(event.id)).map(event=>({kind:"EVIDENCE"as const,id:event.id,evidenceKind:kind,occurredAt:event.observedAt}));result.next=history.next;
  }else if(kind==="SIGNATURE_SIGNED_ARCHIVE"){
   const sent=prefix.selected.find(reference=>reference.kind==="SIGNATURE_SENT"),signature=sent?await repository.proofSignatureEvent(sent.sourceId):null;if(!signature)throw new LeadPipelineEvidenceError();
   const filter=commandFingerprint({operation:"NATIVE_LEAD_STAGE_SIGNED_ARCHIVES",draft}),after=readDocumentCursor(actor,filter,input.cursor),history=await readNativeSignatureHistory(actor,{signatureId:signature.signatureId},nativeDeps);if(history.signature.state!=="SIGNED")throw new LeadPipelineEvidenceError();
   const rows=await repository.signedArchives(signature.signatureId,after);for(const row of rows.slice(0,20)){const proofs=await nativeLeadStageEvidence(actor,tx,{...draft,evidenceReferences:[...prefix.selected,{kind,sourceId:row.id}]},[...prefix.selected.map(value=>value.kind),kind],policy,await repository.clock(),deps);result.items.push({kind:"EVIDENCE",id:row.id,evidenceKind:kind,occurredAt:proofs.find(value=>value.kind===kind)!.occurredAt});}result.next=rows.length>20?documentReadCursor(actor,filter,rows[19].id):null;
  }else if(kind==="OWNER_CONVERSION"){
   if(input.cursor)throw new LeadPipelineEvidenceError();const conversion=await new LeadConversionRepository(tx,actor.organizationId).byLead(input.leadId);if(conversion){const proofs=await nativeLeadStageEvidence(actor,tx,{...draft,evidenceReferences:[...prefix.selected,{kind,sourceId:conversion.id}]},[...prefix.selected.map(value=>value.kind),kind],policy,await repository.clock(),deps);result.items=[{kind:"EVIDENCE",id:conversion.id,evidenceKind:kind,occurredAt:proofs.find(value=>value.kind===kind)!.occurredAt}];}
  }else if(kind==="ONBOARDING_RELEASE")result.dependency="F-ONB-07";
  else if(input.cursor||input.documentId||input.signatureId)throw new LeadPipelineEvidenceError();
  return leadStageEvidenceChoicesSchema.parse(result);
 }catch(error){return nativeLeadStageReadError(error);}
}

/** Normalize canonical source errors at the CRM read boundary without changing stage writers. */
export function nativeLeadStageReadError(error:unknown):never{if(error instanceof DocumentAccessError)throw new LeadAccessError();if(error instanceof DocumentConflictError)throw new LeadPipelineConflictError();throw error;}
