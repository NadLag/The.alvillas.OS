import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DocumentExpiryRevision } from "@prisma/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { DocumentExpiryRepository } from "../infrastructure/document-expiry-repository";
import { documentActorContext, documentArchiveContext, documentAuthorityChecks, documentJson, type DocumentActorContext } from "./document-archive";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";
import { documentSourceReferenceSchema, DocumentAccessError, DocumentConflictError, DocumentConfigurationError, DocumentRateLimitError } from "../domain/document-command";
import { documentExpiryProtocol, documentExpiryDraftSchema, documentExpiryCommandSchema, documentExpiryRecoverySchema, documentExpiryRevisionSchema, documentExpiryHistorySchema, documentExpiryReceiptSchema, documentExpiryRecoveredSchema } from "../domain/document-expiry";
import { documentExpiryPolicyKey, documentExpiryPolicySchema } from "../domain/document-expiry-policy";

type Dependencies={db:TenantTransactionRunner;requestId?:string;env?:NodeJS.ProcessEnv};
type Draft=z.infer<typeof documentExpiryDraftSchema>;
const historyInput=z.object({versionId:z.uuid(),before:z.number().int().positive().optional()}).strict();
const dto=(row:DocumentExpiryRevision)=>documentExpiryRevisionSchema.parse({id:row.id,versionId:row.versionId,number:row.number,previousRevisionId:row.previousId,expiresOn:row.expiresOn?.toISOString().slice(0,10)??null,createdAt:row.createdAt.toISOString(),createdBy:row.createdBy,reason:row.reason});

export async function documentExpiryContext(ctx:DocumentActorContext,tx:TenantTransaction,versionId:string,deps:Pick<Dependencies,"env">={}){
  const repository=new DocumentExpiryRepository(tx,ctx.organizationId),version=await repository.version(versionId);if(!version)throw new DocumentAccessError();
  const generated=generatedDocumentUploadInput.safeParse(version.admission.input),root=await repository.document(version.documentId,generated.success?generated.data.generationInstanceId:undefined);if(!root)throw new DocumentAccessError();
  const source=documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId}),archive=await documentArchiveContext(ctx,tx,source,"view",root,undefined,deps.env),latest=await repository.currentExpiry(version.id);
  const rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:documentExpiryPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:archive.now}),parsed=documentExpiryPolicySchema.safeParse(rule?.value);
  const policy=rule&&parsed.success?{id:rule.id,version:rule.version,value:parsed.data}:null;
  const checks=documentAuthorityChecks(archive.native,archive.privacy,"edit",root);let canEdit=Boolean(policy?.value.type_keys.includes(root.typeKey)&&!archive.native.archived&&!root.archivedAt&&!archive.signedArtifact&&["FILE","INSTANCE"].includes(root.kind));
  if(canEdit)try{await recheckAccountAuthorization(ctx,tx,archive.now,checks,new DocumentAccessError());}catch(error){if(!(error instanceof DocumentAccessError))throw error;canEdit=false;}
  const sourceFingerprint=commandFingerprint({protocol:documentExpiryProtocol,archive:archive.fingerprint,rootId:root.id,rootRevision:root.revision.toString(),versionId:version.id,versionSha256:version.admission.sha256,policy});
  return{repository,version,root,archive:{native:archive.native,privacy:archive.privacy,now:archive.now,fingerprint:archive.fingerprint,signedArtifact:archive.signedArtifact,checks:archive.checks},latest,policy,checks,canEdit,sourceFingerprint};
}
type Current=Awaited<ReturnType<typeof documentExpiryContext>>;
async function unchanged(ctx:DocumentActorContext,tx:TenantTransaction,current:Current,deps:Dependencies,editing=false){
  const final=await documentExpiryContext(ctx,tx,current.version.id,deps);if(final.sourceFingerprint!==current.sourceFingerprint)throw new DocumentConflictError();
  if(editing&&!final.canEdit)throw new DocumentAccessError();return final;
}
function reviewHash(ctx:DocumentActorContext,current:Current,input:Draft){return commandFingerprint({protocol:documentExpiryProtocol,actorId:ctx.actorId,cap:captureAuthorizationCap(ctx.authContext),source:current.sourceFingerprint,input});}
function requireEdit(current:Current){if(!current.policy)throw new DocumentConfigurationError();if(!current.canEdit)throw new DocumentAccessError();}
function requirePrevious(current:Current,input:Draft){if((current.latest?.id??null)!==input.previousRevisionId)throw new DocumentConflictError();}

export async function readDocumentExpiry(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=historyInput.parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const current=await documentExpiryContext(ctx,tx,input.versionId,deps),rows=await current.repository.expiryRevisions(input.versionId,input.before),result=documentExpiryHistorySchema.parse({versionId:input.versionId,current:current.latest?dto(current.latest):null,revisions:rows.slice(0,50).map(dto),next:rows.length>50?rows[49].number:null,canEdit:current.canEdit});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.expiry_history_read",resourceType:"document",resourceId:current.root.id,after:{versionId:input.versionId,count:result.revisions.length},requestId:deps.requestId??randomUUID(),occurredAt:current.archive.now});
    const final=await unchanged(ctx,tx,current,deps);if(final.latest?.id!==current.latest?.id)throw new DocumentConflictError();return result;
  });
}
export async function reviewDocumentExpiry(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentExpiryDraftSchema.parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const current=await documentExpiryContext(ctx,tx,input.versionId,deps);requireEdit(current);requirePrevious(current,input);
    const result={reviewFingerprint:reviewHash(ctx,current,input),current:current.latest?dto(current.latest):null};
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.expiry_reviewed",resourceType:"document",resourceId:current.root.id,after:{versionId:input.versionId,previousRevisionId:input.previousRevisionId},requestId:deps.requestId??randomUUID(),occurredAt:current.archive.now});
    const final=await unchanged(ctx,tx,current,deps,true);requirePrevious(final,input);return result;
  });
}
async function receipt(ctx:DocumentActorContext,tx:TenantTransaction,row:DocumentExpiryRevision,deps:Dependencies){
  if(row.createdBy!==ctx.actorId)throw new DocumentAccessError();const original={...ctx,authContext:restoreAuthorizationCap(row.authorizationCap)};
  const authorities=[ctx,original],contexts=[];for(const authority of authorities)contexts.push(await documentExpiryContext(authority,tx,row.versionId,deps));
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.expiry_receipt_read",resourceType:"document",resourceId:contexts[0].root.id,after:{versionId:row.versionId,revisionId:row.id},requestId:deps.requestId??randomUUID(),occurredAt:contexts[0].archive.now});
  for(const[index,authority]of authorities.entries())await unchanged(authority,tx,contexts[index],deps);
  return documentExpiryReceiptSchema.parse({recorded:true,idempotencyKey:row.commandKey,revision:dto(row)});
}
export async function recoverDocumentExpiry(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentExpiryRecoverySchema.parse(raw);return withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentExpiryRepository(tx,ctx.organizationId);await repository.lock("nonce:"+ctx.actorId+":"+input.idempotencyKey);
    const row=await repository.expiryByNonce(ctx.actorId,input.idempotencyKey);if(row)return receipt(ctx,tx,row,deps);
    if(await repository.expiryNonceOwner(input.idempotencyKey)||await repository.nonceOwner(input.idempotencyKey)||await repository.instanceNonceOwner(input.idempotencyKey)||await repository.signatureNonceOwner(input.idempotencyKey)||await repository.providerPreparationNonceOwner(input.idempotencyKey))throw new DocumentAccessError();
    return documentExpiryRecoveredSchema.parse({recorded:false,idempotencyKey:input.idempotencyKey,revision:null});
  });
}
export async function admitDocumentExpiry(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentExpiryCommandSchema.parse(raw),draft=documentExpiryDraftSchema.parse({versionId:input.versionId,previousRevisionId:input.previousRevisionId,expiresOn:input.expiresOn}),commandHash=commandFingerprint({protocol:documentExpiryProtocol,input});
  const rate=await withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentExpiryRepository(tx,ctx.organizationId);await repository.lock("nonce:"+ctx.actorId+":"+input.idempotencyKey);
    const existing=await repository.expiryByNonce(ctx.actorId,input.idempotencyKey);if(existing){if(existing.commandHash!==commandHash)throw new DocumentConflictError();return{replay:await receipt(ctx,tx,existing,deps),decision:null};}
    if(await repository.expiryNonceOwner(input.idempotencyKey)||await repository.nonceOwner(input.idempotencyKey)||await repository.instanceNonceOwner(input.idempotencyKey)||await repository.signatureNonceOwner(input.idempotencyKey)||await repository.providerPreparationNonceOwner(input.idempotencyKey))throw new DocumentAccessError();
    const current=await documentExpiryContext(ctx,tx,input.versionId,deps);requireEdit(current);requirePrevious(current,draft);if(reviewHash(ctx,current,draft)!==input.reviewFingerprint)throw new DocumentConflictError();
    const budget=current.policy!.value.change_admission,decision=await consumeRateLimit(tx,ctx.organizationId,{key:"document-expiry:"+ctx.actorId,limit:budget.max_requests,windowSeconds:budget.window_seconds,now:current.archive.now});return{replay:null,decision};
  });if(rate.replay)return rate.replay;if(!rate.decision?.allowed)throw new DocumentRateLimitError(rate.decision.resetAt);
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentExpiryRepository(tx,ctx.organizationId);await repository.lock("nonce:"+ctx.actorId+":"+input.idempotencyKey);await repository.lock("expiry:"+input.versionId);
    const existing=await repository.expiryByNonce(ctx.actorId,input.idempotencyKey);if(existing){if(existing.commandHash!==commandHash)throw new DocumentConflictError();return receipt(ctx,tx,existing,deps);}
    const current=await documentExpiryContext(ctx,tx,input.versionId,deps);requireEdit(current);requirePrevious(current,draft);if(reviewHash(ctx,current,draft)!==input.reviewFingerprint)throw new DocumentConflictError();
    const row=await repository.appendExpiry({versionId:input.versionId,previousId:input.previousRevisionId,number:(current.latest?.number??0)+1,expiresOn:input.expiresOn?new Date(input.expiresOn+"T00:00:00.000Z"):null,commandKey:input.idempotencyKey,commandHash,sourceFingerprint:current.sourceFingerprint,authorizationCap:documentJson(captureAuthorizationCap(ctx.authContext)),sourceSnapshot:documentJson({documentId:current.root.id,versionId:current.version.id,versionSha256:current.version.admission.sha256,archiveFingerprint:current.archive.fingerprint,privacy:current.archive.privacy}),policySnapshot:documentJson(current.policy),input:documentJson({...input,protocol:documentExpiryProtocol}),reason:input.reason,createdBy:ctx.actorId,createdAt:current.archive.now});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.expiry_recorded",resourceType:"document",resourceId:current.root.id,after:{revisionId:row.id,documentId:current.root.id,versionId:row.versionId,previousRevisionId:row.previousId,number:row.number,expiresOn:input.expiresOn,commandHash,sourceFingerprint:row.sourceFingerprint},reason:row.reason,requestId:deps.requestId??randomUUID(),occurredAt:row.createdAt});
    const final=await unchanged(ctx,tx,current,deps,true);if(final.latest?.id!==row.id)throw new DocumentConflictError();return receipt(ctx,tx,row,deps);
  });
}
