import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { DocumentRetentionRevision } from "@prisma/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { DocumentRetentionRepository } from "../infrastructure/document-retention-repository";
import { documentActorContext, documentArchiveContext, documentAuthorityChecks, documentJson, type DocumentActorContext } from "./document-archive";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";
import { documentSourceReferenceSchema, DocumentAccessError, DocumentConflictError, DocumentConfigurationError, DocumentRateLimitError } from "../domain/document-command";
import { documentRetentionProtocol, documentRetentionDraftSchema, documentRetentionCommandSchema, documentRetentionRecoverySchema, documentRetentionRevisionSchema, documentRetentionHistoryInputSchema, documentRetentionHistorySchema, documentRetentionReceiptSchema, documentRetentionRecoveredSchema, documentRetentionPolicyContextSchema } from "../domain/document-retention";
import { documentRetentionPolicyKey, documentRetentionPolicySchema, retainedDocumentTags, documentRetentionHookState } from "../domain/document-retention-policy";

type Dependencies={db:TenantTransactionRunner;requestId?:string;env?:NodeJS.ProcessEnv};
type Draft=z.infer<typeof documentRetentionDraftSchema>;
const dto=(row:DocumentRetentionRevision)=>documentRetentionRevisionSchema.parse({id:row.id,versionId:row.versionId,number:row.number,previousRevisionId:row.previousId,tags:row.tags,createdAt:row.createdAt.toISOString(),createdBy:row.createdBy,reason:row.reason});

async function versionContext(ctx:DocumentActorContext,tx:TenantTransaction,versionId:string,deps:Dependencies){
  const repository=new DocumentRetentionRepository(tx,ctx.organizationId),version=await repository.version(versionId);if(!version)throw new DocumentAccessError();
  const generated=generatedDocumentUploadInput.safeParse(version.admission.input),root=await repository.document(version.documentId,generated.success?generated.data.generationInstanceId:undefined);if(!root)throw new DocumentAccessError();
  const archive=await documentArchiveContext(ctx,tx,documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId}),"view",root,undefined,deps.env);
  return{repository,version,root,archive};
}
async function retentionContext(ctx:DocumentActorContext,tx:TenantTransaction,versionId:string,deps:Dependencies){
  const requested=await versionContext(ctx,tx,versionId,deps),inherited=requested.archive.signedArtifact,
    governed=inherited?await versionContext(ctx,tx,inherited.originalVersionId,deps):requested;
  if(governed.archive.signedArtifact||inherited&&(governed.root.id!==inherited.originalDocumentId||governed.version.number!==inherited.originalVersionNumber))throw new DocumentAccessError();
  const latest=await governed.repository.currentRetention(governed.version.id),rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:documentRetentionPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:governed.archive.now}),parsed=documentRetentionPolicySchema.safeParse(rule?.value),policy=rule&&parsed.success?{id:rule.id,version:rule.version,value:parsed.data}:null;
  const checks=documentAuthorityChecks(governed.archive.native,governed.archive.privacy,"edit",governed.root);
  let canEdit=Boolean(!inherited&&policy?.value.type_keys.includes(governed.root.typeKey)&&(policy.value.archive_tagging==="ALLOW"||!governed.archive.native.archived&&!governed.root.archivedAt));
  if(canEdit)try{await recheckAccountAuthorization(ctx,tx,governed.archive.now,checks,new DocumentAccessError());}catch(error){if(!(error instanceof DocumentAccessError))throw error;canEdit=false;}
  const sourceFingerprint=commandFingerprint({protocol:documentRetentionProtocol,requested:{versionId:requested.version.id,sha256:requested.version.admission.sha256,archive:requested.archive.fingerprint},governed:{versionId:governed.version.id,sha256:governed.version.admission.sha256,archive:governed.archive.fingerprint},policy});
  return{requested,governed,latest,policy,canEdit,sourceFingerprint};
}
type Current=Awaited<ReturnType<typeof retentionContext>>;
async function unchanged(ctx:DocumentActorContext,tx:TenantTransaction,current:Current,deps:Dependencies,editing=false){
  const final=await retentionContext(ctx,tx,current.requested.version.id,deps);if(final.sourceFingerprint!==current.sourceFingerprint)throw new DocumentConflictError();if(editing&&!final.canEdit)throw new DocumentAccessError();return final;
}
function requireEdit(current:Current){if(!current.policy)throw new DocumentConfigurationError();if(!current.canEdit)throw new DocumentAccessError();}
function requirePrevious(current:Current,input:Draft){if((current.latest?.id??null)!==input.previousRevisionId)throw new DocumentConflictError();}
function reviewHash(ctx:DocumentActorContext,current:Current,input:Draft){return commandFingerprint({protocol:documentRetentionProtocol,actorId:ctx.actorId,cap:captureAuthorizationCap(ctx.authContext),source:current.sourceFingerprint,input});}
async function requireAvailableNonce(repository:DocumentRetentionRepository,key:string){
  if(await repository.retentionNonceOwner(key)||await repository.nonceOwner(key)||await repository.instanceNonceOwner(key)||await repository.signatureNonceOwner(key)||await repository.providerPreparationNonceOwner(key))throw new DocumentAccessError();
}
async function auditRead(ctx:DocumentActorContext,tx:TenantTransaction,current:Current,deps:Dependencies,action:string,after:Record<string,unknown>,reason?:string){
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action,resourceType:"document",resourceId:current.governed.root.id,after:documentJson({requestedVersionId:current.requested.version.id,versionId:current.governed.version.id,...after}),reason,requestId:deps.requestId??randomUUID(),occurredAt:current.governed.archive.now});
}
export async function readDocumentRetention(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentRetentionHistoryInputSchema.parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const current=await retentionContext(ctx,tx,input.versionId,deps),rows=await current.governed.repository.retentionRevisions(current.governed.version.id,input.before),result=documentRetentionHistorySchema.parse({versionId:input.versionId,governedVersion:{id:current.governed.version.id,documentId:current.governed.root.id,number:current.governed.version.number},current:current.latest?dto(current.latest):null,revisions:rows.slice(0,10).map(dto),next:rows.length>10?rows[9].number:null,canEdit:current.canEdit,configured:Boolean(current.policy),choices:current.canEdit?current.policy!.value.tags:[]});
    await auditRead(ctx,tx,current,deps,"documents.retention_history_read",{count:result.revisions.length});const final=await unchanged(ctx,tx,current,deps);if(final.latest?.id!==current.latest?.id)throw new DocumentConflictError();return result;
  });
}
export async function readDocumentRetentionPolicyContext(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentRetentionHistoryInputSchema.pick({versionId:true}).parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const current=await retentionContext(ctx,tx,input.versionId,deps),tags=current.latest?dto(current.latest).tags:[],result=documentRetentionPolicyContextSchema.parse({versionId:input.versionId,governedVersionId:current.governed.version.id,revisionId:current.latest?.id??null,sourceFingerprint:current.sourceFingerprint,tags,...documentRetentionHookState(tags)});
    await auditRead(ctx,tx,current,deps,"documents.retention_policy_context_read",{revisionId:result.revisionId,sourceFingerprint:result.sourceFingerprint});const final=await unchanged(ctx,tx,current,deps);if(final.latest?.id!==current.latest?.id)throw new DocumentConflictError();return result;
  });
}
export async function reviewDocumentRetention(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentRetentionDraftSchema.parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const current=await retentionContext(ctx,tx,input.versionId,deps);requireEdit(current);requirePrevious(current,input);const tags=retainedDocumentTags(current.policy!.value,input.tagKeys),result={reviewFingerprint:reviewHash(ctx,current,input),current:current.latest?dto(current.latest):null,tags};
    await auditRead(ctx,tx,current,deps,"documents.retention_reviewed",{previousRevisionId:input.previousRevisionId,tagKeys:input.tagKeys});const final=await unchanged(ctx,tx,current,deps,true);requirePrevious(final,input);return result;
  });
}
async function receipt(ctx:DocumentActorContext,tx:TenantTransaction,row:DocumentRetentionRevision,deps:Dependencies){
  if(row.createdBy!==ctx.actorId)throw new DocumentAccessError();const authorities=[ctx,{...ctx,authContext:restoreAuthorizationCap(row.authorizationCap)}],contexts=[];
  for(const authority of authorities)contexts.push(await retentionContext(authority,tx,row.versionId,deps));await auditRead(ctx,tx,contexts[0],deps,"documents.retention_receipt_read",{revisionId:row.id});for(const[index,authority]of authorities.entries())await unchanged(authority,tx,contexts[index],deps);
  return documentRetentionReceiptSchema.parse({recorded:true,idempotencyKey:row.commandKey,revision:dto(row)});
}
export async function recoverDocumentRetention(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentRetentionRecoverySchema.parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentRetentionRepository(tx,ctx.organizationId);await repository.lock("nonce:"+ctx.actorId+":"+input.idempotencyKey);const row=await repository.retentionByNonce(ctx.actorId,input.idempotencyKey);if(row)return receipt(ctx,tx,row,deps);await requireAvailableNonce(repository,input.idempotencyKey);return documentRetentionRecoveredSchema.parse({recorded:false,idempotencyKey:input.idempotencyKey,revision:null});
  });
}
export async function admitDocumentRetention(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentRetentionCommandSchema.parse(raw),draft=documentRetentionDraftSchema.parse({versionId:input.versionId,previousRevisionId:input.previousRevisionId,tagKeys:input.tagKeys}),commandHash=commandFingerprint({protocol:documentRetentionProtocol,input});
  const rate=await withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentRetentionRepository(tx,ctx.organizationId);await repository.lock("nonce:"+ctx.actorId+":"+input.idempotencyKey);const existing=await repository.retentionByNonce(ctx.actorId,input.idempotencyKey);if(existing){if(existing.commandHash!==commandHash)throw new DocumentConflictError();return{replay:await receipt(ctx,tx,existing,deps),decision:null};}await requireAvailableNonce(repository,input.idempotencyKey);
    const current=await retentionContext(ctx,tx,input.versionId,deps);requireEdit(current);requirePrevious(current,draft);retainedDocumentTags(current.policy!.value,input.tagKeys);if(reviewHash(ctx,current,draft)!==input.reviewFingerprint)throw new DocumentConflictError();
    const budget=current.policy!.value.change_admission,decision=await consumeRateLimit(tx,ctx.organizationId,{key:"document-retention:"+ctx.actorId,limit:budget.max_requests,windowSeconds:budget.window_seconds,now:current.governed.archive.now});return{replay:null,decision};
  });if(rate.replay)return rate.replay;if(!rate.decision?.allowed)throw new DocumentRateLimitError(rate.decision.resetAt);
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentRetentionRepository(tx,ctx.organizationId);await repository.lock("nonce:"+ctx.actorId+":"+input.idempotencyKey);await repository.lock("retention:"+input.versionId);const existing=await repository.retentionByNonce(ctx.actorId,input.idempotencyKey);if(existing){if(existing.commandHash!==commandHash)throw new DocumentConflictError();return receipt(ctx,tx,existing,deps);}await requireAvailableNonce(repository,input.idempotencyKey);
    const current=await retentionContext(ctx,tx,input.versionId,deps);requireEdit(current);requirePrevious(current,draft);if(reviewHash(ctx,current,draft)!==input.reviewFingerprint)throw new DocumentConflictError();const tags=retainedDocumentTags(current.policy!.value,input.tagKeys);
    const row=await repository.appendRetention({versionId:input.versionId,previousId:input.previousRevisionId,number:(current.latest?.number??0)+1,tagKeys:input.tagKeys,tags:documentJson(tags),commandKey:input.idempotencyKey,commandHash,sourceFingerprint:current.sourceFingerprint,authorizationCap:documentJson(captureAuthorizationCap(ctx.authContext)),sourceSnapshot:documentJson({documentId:current.governed.root.id,versionId:current.governed.version.id,versionSha256:current.governed.version.admission.sha256,archiveFingerprint:current.governed.archive.fingerprint,privacy:current.governed.archive.privacy}),policySnapshot:documentJson(current.policy),input:documentJson({...input,protocol:documentRetentionProtocol}),reason:input.reason,createdBy:ctx.actorId,createdAt:current.governed.archive.now});
    await auditRead(ctx,tx,current,deps,"documents.retention_recorded",{revisionId:row.id,documentId:current.governed.root.id,previousRevisionId:row.previousId,number:row.number,tagKeys:row.tagKeys,commandHash:row.commandHash,sourceFingerprint:row.sourceFingerprint},row.reason);
    const final=await unchanged(ctx,tx,current,deps,true);if(final.latest?.id!==row.id)throw new DocumentConflictError();return receipt(ctx,tx,row,deps);
  });
}
