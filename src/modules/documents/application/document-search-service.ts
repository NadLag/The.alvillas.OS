import { DocumentArchiveReadPhase } from "./document-archive-read-phase";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { present } from "@/platform/authz/present";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentSearchRepository } from "../infrastructure/document-search-repository";
import { documentActorContext, documentArchiveContext, presentDocumentVersion, type DocumentActorContext } from "./document-archive";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";
import { DocumentAccessError, DocumentConflictError, DocumentConfigurationError, documentSourceReferenceSchema } from "../domain/document-command";
import { documentSourceKinds, retainedDocumentCategory } from "../domain/document-policy";
import { documentSearchInputSchema, documentSearchItemSchema, documentSearchProtocol, documentSearchResultSchema } from "../domain/document-search";

type Dependencies={db:TenantTransactionRunner;env?:NodeJS.ProcessEnv;requestId?:string};
type SourceKind=typeof documentSourceKinds[number];
const cursorSchema=z.object({protocol:z.literal(documentSearchProtocol),organizationId:z.uuid(),actorId:z.uuid(),filter:z.string(),cap:z.string(),before:z.uuid(),asOf:z.iso.datetime()}).strict();
// These necessary permissions only exclude impossible candidates. The shared
// archive still decides every source/document/template/financial publication.
const necessary:Record<SourceKind,readonly string[]>={PROPERTY:["property:view"],RESERVATION:["reservation:view","property:view"],OWNER:["owner:view"],PERSON:["team_member:view","staff_document:view"],SUPPLIER:["supplier:view"],GUEST:["guest:view"],ORGANIZATION:["organization:view"],FINANCIAL_TRANSACTION:["financial_transaction:view"]};
const financial:Partial<Record<SourceKind,string>>={PROPERTY:"property_finance:view",RESERVATION:"property_finance:view",OWNER:"owner_statement:view",PERSON:"staff_compensation:view",SUPPLIER:"company_ledger:view",GUEST:"company_ledger:view",ORGANIZATION:"company_ledger:view"};
async function versionContext(ctx:DocumentActorContext,tx:TenantTransaction,id:string,deps:Dependencies,readPhase?:DocumentArchiveReadPhase){
  const repository=readPhase?readPhase.repository(ctx,tx):new DocumentSearchRepository(tx,ctx.organizationId),version=await repository.metadataVersion(id);if(!version)throw new DocumentAccessError();const generation=generatedDocumentUploadInput.safeParse(version.admission.input),root=await repository.searchDocument(version.documentId,generation.success?generation.data.generationInstanceId:undefined);if(!root)throw new DocumentAccessError();
  const source=documentSourceReferenceSchema.parse({kind:root.sourceKind,id:root.sourceId}),archive=await documentArchiveContext(ctx,tx,source,"view",root,undefined,deps.env,readPhase);return{repository,version,root,source,archive};
}
export async function searchDocuments(actor:DocumentActorContext,raw:unknown,deps:Dependencies){
  const ctx=documentActorContext(actor),input=documentSearchInputSchema.parse(raw),{cursor:encoded,...filters}=input,filter=commandFingerprint({protocol:documentSearchProtocol,...filters}),cap=commandFingerprint(captureAuthorizationCap(ctx.authContext));
  let cursor:z.infer<typeof cursorSchema>|null=null;if(encoded)try{cursor=cursorSchema.parse(JSON.parse(decryptSecret(encoded,deps.env)));if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.filter!==filter||cursor.cap!==cap)throw new DocumentConflictError();}catch{throw new DocumentConflictError();}
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new DocumentSearchRepository(tx,ctx.organizationId),now=await repository.clock(),stored=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),authorities=[ctx.authContext,stored];if(authorities.some(a=>!a.permissions.has("document:view")))throw new DocumentAccessError();
    const asOf=cursor?new Date(cursor.asOf):now;if(asOf>now)throw new DocumentConflictError();
    const sourceKinds=documentSourceKinds.filter(kind=>authorities.every(a=>necessary[kind].every(key=>a.permissions.has(key)))),financialDenied=documentSourceKinds.filter(kind=>financial[kind]&&authorities.some(a=>!a.permissions.has(financial[kind]!)));
    const readPhase=await DocumentArchiveReadPhase.create(ctx,tx);
    const matches:Array<{item:z.infer<typeof documentSearchItemSchema>;context:Awaited<ReturnType<typeof versionContext>>;effectiveId:string|null}>=[];let before=cursor?.before;
    while(matches.length<21){const rows=await repository.searchCandidates(input,sourceKinds,financialDenied,asOf,before);if(!rows.length)break;
      for(let offset=0;offset<Math.min(rows.length,100)&&matches.length<21;offset+=21){
        const batch=rows.slice(offset,Math.min(offset+21,100));await readPhase.prepare(ctx,tx,batch.map(row=>row.id),asOf);
        for(const row of batch){
        let current:Awaited<ReturnType<typeof versionContext>>;try{current=await versionContext(ctx,tx,row.id,deps,readPhase);}catch(error){if(error instanceof DocumentAccessError||error instanceof DocumentConfigurationError)continue;throw error;}
        if(!input.includeArchived&&(current.root.archivedAt||current.archive.native.archived))continue;
        const effective=await current.repository.effectiveMetadata(current.root.id,asOf),state=effective?.id===row.id?"CURRENT_EFFECTIVE":(current.version.effectiveFrom??current.version.createdAt)>asOf?"SCHEDULED":"RETAINED";
        if(input.versionSelection==="CURRENT_EFFECTIVE"&&state!=="CURRENT_EFFECTIVE")continue;
        const {root,archive}=current,data={id:root.id,source:current.source,typeKey:root.typeKey,...retainedDocumentCategory(root.policySnapshot,root.typeKey),kind:root.kind,locale:root.locale,title:root.title,privacy:archive.privacy,revision:root.revision.toString(),createdAt:root.createdAt.toISOString(),archivedAt:root.archivedAt?.toISOString()??null,templateKey:root.template?.key??null,...archive.signedArtifact?{signedArtifact:archive.signedArtifact}:{}};
        const document=present({...ctx.authContext,visibleDataClasses:new Set(archive.privacy)},"view",{...archive.native.resource,type:"document",id:root.id,documentId:root.id,assignedUserAccountId:root.createdBy,data},{},archive.now),item=documentSearchItemSchema.parse({document,version:presentDocumentVersion(ctx,archive,root,current.version),sourceLabel:archive.native.label,state});
        matches.push({item,context:current,effectiveId:effective?.id??null});if(matches.length===21)break;
      }
      }
      if(matches.length===21||rows.length<=100)break;before=rows[99].id;
    }
    const published=matches.slice(0,20),next=matches.length>20?encryptSecret(JSON.stringify({protocol:documentSearchProtocol,organizationId:ctx.organizationId,actorId:ctx.actorId,filter,cap,before:published[19].item.version.id,asOf:asOf.toISOString()}),deps.env):null;
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"documents.search_read",resourceType:"document",resourceId:null,after:{queryFingerprint:filter,count:published.length,versionIds:published.map(match=>match.item.version.id)},requestId:deps.requestId??randomUUID(),occurredAt:now});
    const finalPhase=await DocumentArchiveReadPhase.create(ctx,tx);await finalPhase.prepare(ctx,tx,matches.map(match=>match.item.version.id),finalPhase.instant(ctx,tx));
    for(const match of matches){const final=await versionContext(ctx,tx,match.item.version.id,deps,finalPhase);if(final.archive.fingerprint!==match.context.archive.fingerprint||final.version.admission.sha256!==match.context.version.admission.sha256)throw new DocumentConflictError();
      }
    if(input.versionSelection==="CURRENT_EFFECTIVE"){const effective=await repository.effectiveVersions(matches.map(match=>match.context.root.id),await repository.clock());for(const match of matches)if(effective.get(match.context.root.id)?.id!==match.effectiveId)throw new DocumentConflictError();}
    if(!(await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId)).permissions.has("document:view"))throw new DocumentAccessError();await recheckAccountAuthorization(ctx,tx,await repository.clock(),matches.flatMap(match=>match.context.archive.checks),new DocumentAccessError());
    return documentSearchResultSchema.parse({items:published.map(match=>match.item),next,observedAt:asOf.toISOString()});
  });
}
