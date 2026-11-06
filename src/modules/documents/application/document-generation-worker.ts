import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { DocumentRepository } from "../infrastructure/document-repository";
import { documentGenerationRequested, documentGenerationSnapshotSchema } from "../domain/document-generation";
import { DocumentAccessError } from "../domain/document-command";
import { documentGenerationOutboxKey } from "./document-generation-admission";
import { publishDocumentGeneration } from "./document-generation-publication";
import { configuredDocumentObjects } from "./document-files";

const referenceSchema=z.object({organizationId:z.uuid(),outboxEventId:z.uuid()}).strict(),payloadSchema=z.object({instanceId:z.uuid()}).strict();
type Reference=z.infer<typeof referenceSchema>;
type Dependencies=Partial<Omit<Parameters<typeof publishDocumentGeneration>[2],"db">>&{db?:TenantTransactionRunner};
async function referenced(tx:TenantTransaction,reference:Reference){
  const event=await new OutboxRepository(tx,reference.organizationId).event(reference.outboxEventId);
  if(!event||event.type!==documentGenerationRequested||event.status==="FAILED")throw new DocumentAccessError();
  const payload=payloadSchema.parse(event.payload),row=await new DocumentRepository(tx,reference.organizationId).instance(payload.instanceId);
  if(!row||event.idempotencyKey!==documentGenerationOutboxKey(row.createdBy,row.commandKey)||event.occurredAt.getTime()!==row.createdAt.getTime())throw new DocumentAccessError();
  const snapshot=documentGenerationSnapshotSchema.parse(row.sourceSnapshot),authority=restoreAuthorizationCap(snapshot.authorizationCap);
  if(authority.organizationId!==reference.organizationId||authority.userAccountId!==row.createdBy)throw new DocumentAccessError();
  return{row,actor:{organizationId:reference.organizationId,actorId:row.createdBy,authContext:authority}};
}
export async function executeDocumentGenerationReference(raw:unknown,deps:Dependencies={}){
  const reference=referenceSchema.parse(raw),db=deps.db??prisma,original=await withTenant(db,reference.organizationId,tx=>referenced(tx,reference));
  return publishDocumentGeneration(original.actor,{instanceId:original.row.id},{...deps,db,objects:deps.objects??configuredDocumentObjects()});
}
export async function failDocumentGenerationReference(raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const reference=referenceSchema.parse(raw),db=deps.db??prisma;
  return withTenant(db,reference.organizationId,async tx=>{const{row}=await referenced(tx,reference),repository=new DocumentRepository(tx,reference.organizationId);
    if(await repository.latest(row.documentId))return{recorded:false};
    await writeAuditEvent(tx,{organizationId:reference.organizationId,actorId:null,action:"documents.generation_failed",resourceType:"document",resourceId:row.documentId,
      after:{instanceId:row.id,outboxEventId:reference.outboxEventId},reason:"Native document generation exhausted its background execution; the original encrypted intent remains recoverable",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await repository.clock()});return{recorded:true};});
}
