import { createHash,randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { financialAttachmentIntentSchema } from "@/modules/finance/domain/financial-attachment";
import { financialAttachmentPolicySchema } from "@/modules/finance/domain/financial-attachment-policy";
import { financialAttachmentMaximumBytes,financialAttachmentUploadChunkBytes,financialAttachmentSingleBodyBytes,financialAttachmentUploadMaximumParts,
  financialAttachmentPartsSchema,financialAttachmentPartContract,financialAttachmentPartReferenceSchema } from "@/modules/finance/domain/financial-attachment-parts";
const digest=(value:string)=>createHash("sha256").update(value).digest("hex"),identity=(size=financialAttachmentUploadChunkBytes+17)=>({organizationId:randomUUID(),transactionId:randomUUID(),id:randomUUID(),contentType:"application/pdf",fileSize:size,sha256:digest("original immutable file")}),
 parts=(count=2)=>({schemaVersion:1 as const,chunkBytes:financialAttachmentUploadChunkBytes,hashes:Array.from({length:count},(_,index)=>digest("Original part "+index))});
describe("bounded private financial attachment parts",()=>{
 it("retains the full existing50MiB envelope inside shared bounded request framing",()=>{
  expect(financialAttachmentMaximumBytes).toBe(50*1024*1024);expect(financialAttachmentUploadChunkBytes).toBeLessThanOrEqual(financialAttachmentSingleBodyBytes);expect(Math.ceil(financialAttachmentMaximumBytes/financialAttachmentUploadChunkBytes)).toBeLessThanOrEqual(financialAttachmentUploadMaximumParts);
  const original=identity(financialAttachmentMaximumBytes),manifest=parts(Math.ceil(original.fileSize/financialAttachmentUploadChunkBytes));expect(financialAttachmentPartsSchema.parse(manifest)).toEqual(manifest);for(let index=0;index<manifest.hashes.length;index++)expect(financialAttachmentPartContract(original,index,manifest).size).toBe(financialAttachmentUploadChunkBytes);
 });
 it("binds exact original identity, part index, final size and every digest into authenticated framing",()=>{
  const original=identity(),manifest=parts(),first=financialAttachmentPartContract(original,0,manifest),last=financialAttachmentPartContract(original,1,manifest);expect(first.size).toBe(financialAttachmentUploadChunkBytes);expect(last.size).toBe(17);expect(last.sha256).toBe(manifest.hashes[1]);expect(first.key).not.toBe(last.key);expect(first.context).not.toBe(last.context);expect(first.key).toContain(original.organizationId);expect(first.key).toContain(original.transactionId);expect(first.key).toContain(original.id);expect(JSON.parse(last.context)).toEqual(["financial-attachment-upload-part-v1",original.organizationId,original.transactionId,original.id,original.contentType,original.fileSize,original.sha256,1,financialAttachmentUploadChunkBytes,1,17,manifest.hashes[1]]);
 });
 it.each(["organizationId","transactionId","id","contentType","fileSize","sha256"] as const)("cannot borrow a part when original %s changes",field=>{
  const original=identity(),changed={...original,[field]:field==="fileSize"?original.fileSize+1:field==="contentType"?"image/png":field==="sha256"?digest("different original"):randomUUID()},manifest=parts();expect(financialAttachmentPartContract(changed,0,manifest).context).not.toBe(financialAttachmentPartContract(original,0,manifest).context);
 });
 it("permits equal digests for identical original parts and never merges their identities",()=>{
  const original=identity(2*financialAttachmentUploadChunkBytes),hash=digest("equal original chunks"),manifest={...parts(),hashes:[hash,hash]};expect(financialAttachmentPartsSchema.parse(manifest).hashes).toEqual([hash,hash]);expect(financialAttachmentPartContract(original,0,manifest).key).not.toBe(financialAttachmentPartContract(original,1,manifest).key);
 });
 it.each([-1,.5,2,64])("refuses an out-of-range original part %s",index=>expect(()=>financialAttachmentPartContract(identity(),index,parts())).toThrow());
 it("rejects noncanonical, unbounded or contradictory manifests before transport",()=>{
  for(const value of[{...parts(),extra:true},{...parts(),schemaVersion:2},{...parts(),chunkBytes:financialAttachmentSingleBodyBytes},{...parts(),hashes:[]},{...parts(),hashes:Array.from({length:65},()=>digest("part"))},{...parts(),hashes:[digest("part").toUpperCase()]}])expect(financialAttachmentPartsSchema.safeParse(value).success).toBe(false);
  expect(()=>financialAttachmentPartContract(identity(),0,parts(1))).toThrow();expect(()=>financialAttachmentPartContract({...identity(),fileSize:financialAttachmentMaximumBytes+1},0,parts())).toThrow();expect(financialAttachmentPartReferenceSchema.safeParse({id:randomUUID(),index:0,organizationId:randomUUID()}).success).toBe(false);
 });
 it("preserves legacy admission fields while durably fingerprinting an optional exact manifest",()=>{
  const file=identity(),draft={transactionId:file.transactionId,idempotencyKey:randomUUID(),kind:"RECEIPT",fileName:"original.pdf",contentType:file.contentType,fileSize:file.fileSize,sha256:file.sha256,supersedesId:null,reason:"Retain original immutable receipt"};expect(financialAttachmentIntentSchema.parse(draft)).toEqual(draft);expect(financialAttachmentIntentSchema.parse({...draft,parts:parts()}).parts).toEqual(parts());expect(financialAttachmentIntentSchema.safeParse({...draft,parts:parts(1)}).success).toBe(false);
 });
 it("requires explicit positive configured transport budgets without inventing legacy settings",()=>{
  const legacy={source:"ORIGINAL_SEALED_FINANCIAL_TRANSACTION",content_types:["application/pdf"],max_bytes:financialAttachmentMaximumBytes,intent_lifetime_seconds:60,storage_read_ttl_seconds:30,encryption:"APP_MANAGED_AUTHENTICATED_ENCRYPTION",history:"APPEND_ONLY_WITH_RETAINED_SUPERSEDED_FILES",rate_limit:{requests:100,window_seconds:3600}};expect(financialAttachmentPolicySchema.parse(legacy)).toEqual(legacy);expect(financialAttachmentPolicySchema.parse({...legacy,upload_transport:{max_requests:70,window_seconds:300}}).upload_transport).toEqual({max_requests:70,window_seconds:300});for(const budget of[{max_requests:0,window_seconds:300},{max_requests:70,window_seconds:0},{max_requests:1.5,window_seconds:300},{max_requests:70,window_seconds:300,default:true}])expect(financialAttachmentPolicySchema.safeParse({...legacy,upload_transport:budget}).success).toBe(false);
 });
});
