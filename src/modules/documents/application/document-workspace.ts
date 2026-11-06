import { randomUUID } from "node:crypto";
import { z } from "zod";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { authorizeOrganizationSource, authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { present } from "@/platform/authz/present";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { DocumentRepository } from "../infrastructure/document-repository";
import { documentSourceKinds, retainDocumentPrivacy } from "../domain/document-policy";
import { documentSourceReferenceSchema, documentListInput, DocumentAccessError, DocumentConflictError } from "../domain/document-command";
import { documentItemSchema, documentSourceChoicesSchema, documentSourceWorkspaceSchema } from "../domain/document-read-model";
import { documentSourceContext, documentAuthorityChecks, type DocumentActorContext } from "./document-archive";

type Dependencies = { db: TenantTransactionRunner; requestId?: string };
const candidatesInput = z.object({ kind: z.enum(documentSourceKinds), query: z.string().trim().max(120).default(""), cursor: z.string().max(6000).optional() }).strict();
const workspaceInput = documentListInput.safeExtend({ kind: z.enum(["FILE","TEMPLATE"]).default("FILE") });
const cursorSchema = z.object({ version: z.literal(1), actorId: z.uuid(), organizationId: z.uuid(), filter: z.string(), before: z.uuid() }).strict();
const allowed = (ctx: AuthContext, checks: readonly CurrentAuthorityCheck[], now: Date) => checks.every(check => check.organizationOnly ? authorizeOrganizationSource(ctx,check.action,check.resource,now)
  : check.unconditional ? authorizeUnconditionalSource(ctx,check.action,check.resource,now) : authorize(ctx,check.action,check.resource,now));
function actorContext(actor: DocumentActorContext) {
  if(actor.organizationId!==actor.authContext.organizationId||actor.actorId!==actor.authContext.userAccountId) throw new DocumentAccessError();
  return {...actor,authContext:restoreAuthorizationCap(captureAuthorizationCap(actor.authContext))};
}
function cursor(ctx: DocumentActorContext, filter: string, before?: string) {
  return before ? encryptSecret(JSON.stringify({version:1,actorId:ctx.actorId,organizationId:ctx.organizationId,filter,before})) : null;
}
function before(ctx: DocumentActorContext, filter: string, raw?: string) {
  if(!raw)return undefined;
  try {const value=cursorSchema.parse(JSON.parse(decryptSecret(raw)));if(value.organizationId!==ctx.organizationId||value.actorId!==ctx.actorId||value.filter!==filter)throw new DocumentConflictError();return value.before;}
  catch {throw new DocumentConflictError();}
}

export async function readDocumentSources(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx=actorContext(actor),input=candidatesInput.parse(raw),filter=commandFingerprint({operation:"SOURCES",kind:input.kind,query:input.query}),after=before(ctx,filter,input.cursor);
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    if([ctx.authContext,current].some(authority=>!authority.permissions.has("document:view")))throw new DocumentAccessError();
    const repository=new DocumentRepository(tx,ctx.organizationId),rows=await repository.sourceCandidates(input.kind,input.query,after),items=[],checks:CurrentAuthorityCheck[]=[],captured=[];
    for(const row of rows.slice(0,30)){
      const source={kind:input.kind,id:row.id},native=await repository.documentSource(source);if(!native)continue;
      const now=await repository.clock();if(![ctx.authContext,current].every(authority=>allowed(authority,native.checks,now)))continue;
      checks.push(...native.checks);captured.push({source,fingerprint:native.fingerprint});
      const visible=present({...ctx.authContext,visibleDataClasses:new Set([native.resource.dataClass??"operational"])},"view",{...native.resource,data:{source,label:row.label}},{},now);
      items.push({source:documentSourceReferenceSchema.parse(visible.source),label:z.string().parse(visible.label)});
    }
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.sources_read",resourceType:"document",resourceId:null,after:{count:items.length},requestId:deps.requestId??randomUUID(),occurredAt:await repository.clock()});
    for(const saved of captured){const final=await repository.documentSource(saved.source);if(!final||final.fingerprint!==saved.fingerprint)throw new DocumentConflictError();checks.push(...final.checks);}
    await recheckAccountAuthorization(ctx,tx,await repository.clock(),checks,new DocumentAccessError());
    if(!(await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId)).permissions.has("document:view"))throw new DocumentAccessError();
    return documentSourceChoicesSchema.parse({items,next:rows.length>30?cursor(ctx,filter,rows[29].id):null});
  });
}

export async function readDocumentSourceWorkspace(actor: DocumentActorContext, raw: unknown, deps: Dependencies) {
  const ctx=actorContext(actor),input=workspaceInput.parse(raw),filter=commandFingerprint({operation:"DOCUMENTS",source:input.source,typeKey:input.typeKey??null,locale:input.locale??null,kind:input.kind}),after=before(ctx,filter,input.cursor);
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const base=await documentSourceContext(ctx,tx,input.source,"view"),stored=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),checks=[...base.native.checks],types=[],items=[],captured=[];
    if([ctx.authContext,stored].some(authority=>!authority.permissions.has("document:view")))throw new DocumentAccessError();
    for(const type of base.policy.value.types.filter(type=>type.sources.includes(input.source.kind))){
      const privacy=retainDocumentPrivacy([],type.privacy,input.source.kind),required=documentAuthorityChecks(base.native,privacy,"create",{kind:input.kind,createdBy:ctx.actorId});
      if(!base.native.archived&&[ctx.authContext,stored].every(authority=>allowed(authority,required,base.now))){checks.push(...required);types.push({key:type.key,labels:type.labels,contentTypes:type.content_types,maxBytes:type.max_bytes});}
    }
    const rows=await base.repository.roots(input.source,after,input.typeKey,input.locale);
    for(const root of rows.slice(0,50)){
      const type=base.policy.value.types.find(type=>type.key===root.typeKey),privacy=retainDocumentPrivacy(root.privacy,type?.privacy??[],input.source.kind),required=documentAuthorityChecks(base.native,privacy,"view",root);
      if(![ctx.authContext,stored].every(authority=>allowed(authority,required,base.now)))continue;
      checks.push(...required);captured.push({id:root.id,revision:root.revision.toString(),privacy:root.privacy});
      const data={id:root.id,source:input.source,typeKey:root.typeKey,kind:root.kind,locale:root.locale,title:root.title,privacy,revision:root.revision.toString(),createdAt:root.createdAt.toISOString(),archivedAt:root.archivedAt?.toISOString()??null};
      items.push(documentItemSchema.parse(present({...ctx.authContext,visibleDataClasses:new Set(privacy)},"view",{...base.native.resource,type:"document",id:root.id,documentId:root.id,assignedUserAccountId:root.createdBy,data},{},base.now)));
    }
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.source_read",resourceType:"document",resourceId:null,after:{count:items.length},requestId:deps.requestId??randomUUID(),occurredAt:base.now});
    const final=await documentSourceContext(ctx,tx,input.source,"view");if(final.native.fingerprint!==base.native.fingerprint||commandFingerprint(final.policy)!==commandFingerprint(base.policy))throw new DocumentConflictError();
    const protections=await final.repository.rootProtections(captured.map(root=>root.id));
    for(const capturedRoot of captured){const root=protections.get(capturedRoot.id);if(!root||root.revision.toString()!==capturedRoot.revision||commandFingerprint(root.privacy)!==commandFingerprint(capturedRoot.privacy))throw new DocumentConflictError();}
    await recheckAccountAuthorization(ctx,tx,await base.repository.clock(),checks,new DocumentAccessError());
    if(!(await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId)).permissions.has("document:view"))throw new DocumentAccessError();
    return documentSourceWorkspaceSchema.parse({source:input.source,sourceLabel:final.native.label,items,types,next:rows.length>50?cursor(ctx,filter,rows[49].id):null});
  });
}
