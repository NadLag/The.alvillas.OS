import { createHash } from "node:crypto";
import { withTenant } from "@/platform/db/tenant";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { FinancialAttachmentRepository } from "../infrastructure/financial-attachment-repository";
import { financialAttachmentReferenceSchema,FinancialAttachmentAccessError,FinancialAttachmentConfigurationError,FinancialAttachmentConflictError,FinancialAttachmentRateLimitError,FinancialAttachmentValidationError } from "../domain/financial-attachment";
import { financialAttachmentPartsSchema,financialAttachmentPartReferenceSchema,financialAttachmentPartContract } from "../domain/financial-attachment-parts";
import { financialAttachmentPartReceiptSchema } from "../domain/financial-attachment-read-model";
import { financialAttachmentActor,financialAttachmentAdmissionContext,financialAttachmentContext,financialAttachmentObjectIdentity,auditFinancialAttachment,presentFinancialAttachment,uploadFinancialAttachment,type FinancialAttachmentDependencies } from "./financial-attachments";
import type { FinanceActorContext } from "./finance-access";

export async function uploadFinancialAttachmentPart(actor:FinanceActorContext,raw:unknown,bytes:Uint8Array,deps:FinancialAttachmentDependencies){
  const ctx=financialAttachmentActor(actor),input=financialAttachmentPartReferenceSchema.parse(raw);
  const captured=await withTenant(deps.db,ctx.organizationId,async tx=>{
    const row=await new FinancialAttachmentRepository(tx,ctx.organizationId).admission(input.id);if(!row)throw new FinancialAttachmentAccessError();const current=await financialAttachmentAdmissionContext(ctx,tx,row);
    if(row.uploadParts===null)throw new FinancialAttachmentConflictError();const parts=financialAttachmentPartsSchema.parse(row.uploadParts);if(input.index>=parts.hashes.length)throw new FinancialAttachmentValidationError();const contract=financialAttachmentPartContract(financialAttachmentObjectIdentity(ctx,row),input.index,parts);
    if(bytes.length!==contract.size||createHash("sha256").update(bytes).digest("hex")!==contract.sha256)throw new FinancialAttachmentValidationError();
    const budget=current.policy.upload_transport;if(!budget)throw new FinancialAttachmentConfigurationError();const decision=await consumeRateLimit(tx,ctx.organizationId,{key:"finance.financial_attachment.parts:"+ctx.actorId,limit:budget.max_requests,windowSeconds:budget.window_seconds,now:current.now});
    return{row,parts,partSha256:contract.sha256,source:current.native.identity,policy:current.policyIdentity,ttl:current.policy.storage_read_ttl_seconds,decision};
  });
  if(!captured.decision.allowed)throw new FinancialAttachmentRateLimitError(captured.decision.resetAt);
  if(!captured.row.attachment){if(!deps.objects)throw new FinancialAttachmentConfigurationError();await deps.objects.putPart(financialAttachmentObjectIdentity(ctx,captured.row),input.index,captured.parts,bytes,captured.ttl);}
  return withTenant(deps.db,ctx.organizationId,async tx=>{
    const row=await new FinancialAttachmentRepository(tx,ctx.organizationId).admission(input.id);if(!row)throw new FinancialAttachmentAccessError();const current=await financialAttachmentAdmissionContext(ctx,tx,row);
    if(current.native.identity!==captured.source||current.policyIdentity!==captured.policy)throw new FinancialAttachmentConflictError();
    await auditFinancialAttachment(ctx,tx,row,"finance.financial_attachment.part_saved",current.now,deps,{index:input.index,partSha256:captured.partSha256});
    const final=await financialAttachmentAdmissionContext(ctx,tx,row);if(final.native.identity!==captured.source||final.policyIdentity!==captured.policy)throw new FinancialAttachmentConflictError();
    return financialAttachmentPartReceiptSchema.parse({id:row.id,idempotencyKey:row.idempotencyKey,index:input.index,sha256:captured.partSha256,attached:Boolean(row.attachment)});
  });
}

export async function completeFinancialAttachmentParts(actor:FinanceActorContext,raw:unknown,deps:FinancialAttachmentDependencies){
  const ctx=financialAttachmentActor(actor),input=financialAttachmentReferenceSchema.parse(raw),captured=await withTenant(deps.db,ctx.organizationId,async tx=>{
    const repository=new FinancialAttachmentRepository(tx,ctx.organizationId),row=await repository.admission(input.id);if(!row)throw new FinancialAttachmentAccessError();const current=await financialAttachmentAdmissionContext(ctx,tx,row);
    if(row.uploadParts===null)throw new FinancialAttachmentConflictError();const parts=financialAttachmentPartsSchema.parse(row.uploadParts);
    if(row.attachment){const original=await repository.attachment(row.id);if(!original)throw new FinancialAttachmentAccessError();const visible=await financialAttachmentContext(ctx,tx,row.transactionId,"view",original.rootId);return{row,parts,ttl:current.policy.storage_read_ttl_seconds,result:presentFinancialAttachment(ctx,visible,original),decision:null};}
    const budget=current.policy.upload_transport;if(!budget)throw new FinancialAttachmentConfigurationError();const decision=await consumeRateLimit(tx,ctx.organizationId,{key:"finance.financial_attachment.parts:"+ctx.actorId,limit:budget.max_requests,windowSeconds:budget.window_seconds,now:current.now});return{row,parts,ttl:current.policy.storage_read_ttl_seconds,result:null,decision};
  });
  if(captured.result)return captured.result;if(captured.decision&&!captured.decision.allowed)throw new FinancialAttachmentRateLimitError(captured.decision.resetAt);
  if(!deps.objects)throw new FinancialAttachmentConfigurationError();const objects=deps.objects,chunks:Buffer[]=[];
  for(let start=0;start<captured.parts.hashes.length;start+=4){const indices=Array.from({length:Math.min(4,captured.parts.hashes.length-start)},(_,offset)=>start+offset);chunks.push(...await Promise.all(indices.map(index=>objects.readPart(financialAttachmentObjectIdentity(ctx,captured.row),index,captured.parts,captured.ttl))));}
  return uploadFinancialAttachment(ctx,input,Buffer.concat(chunks),deps);
}
