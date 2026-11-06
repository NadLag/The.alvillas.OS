import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { documentUploadReviewInput } from "@/modules/documents/domain/document-command";
import { documentArchivePolicySchema } from "@/modules/documents/domain/document-policy";
import { documentUploadChunkBytes,documentSingleBodyBytes,documentPartContract } from "@/modules/documents/domain/document-upload-parts";
import { documentUploadAdmissionSchema } from "@/modules/documents/domain/document-read-model";

const metadata={documentId:null,source:{kind:"PROPERTY",id:randomUUID()},typeKey:"agreement",kind:"FILE",locale:"fr",title:"Original declared archive",fileName:"original.pdf",contentType:"application/pdf",fileSize:100,sha256:"a".repeat(64),supersedesId:null,effectiveFrom:null,templateKey:null};
const parts=(size:number)=>({schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:Array.from({length:Math.ceil(size/documentUploadChunkBytes)},()=>"a".repeat(64))});
describe("bounded original document transfer protocol",()=>{
  it("keeps legacy small metadata valid and requires an exact manifest above the single-request bound",()=>{
    expect(documentUploadReviewInput.safeParse(metadata).success).toBe(true);const large={...metadata,fileSize:documentSingleBodyBytes+1};expect(documentUploadReviewInput.safeParse(large).success).toBe(false);expect(documentUploadReviewInput.safeParse({...large,parts:parts(large.fileSize)}).success).toBe(true);
  });
  it.each([{schemaVersion:2,chunkBytes:documentUploadChunkBytes,hashes:["a".repeat(64)]},{schemaVersion:1,chunkBytes:documentUploadChunkBytes+1,hashes:["a".repeat(64)]},{schemaVersion:1,chunkBytes:documentUploadChunkBytes,hashes:["A".repeat(64)]},{schemaVersion:1,chunkBytes:documentUploadChunkBytes,hashes:["a".repeat(64),"b".repeat(64)]},{schemaVersion:1,chunkBytes:documentUploadChunkBytes,hashes:["a".repeat(64)],storageKey:"foreign"}])("rejects substituted framing, hashes, counts or storage authority %#",manifest=>{expect(documentUploadReviewInput.safeParse({...metadata,parts:manifest}).success).toBe(false);});
  it("binds each native part to its original full file, tenant, document, admission and index",()=>{
    const identity={organizationId:randomUUID(),documentId:randomUUID(),admissionId:randomUUID(),contentType:"application/pdf" as const,fileSize:documentUploadChunkBytes+10,sha256:"c".repeat(64)},manifest=parts(identity.fileSize),first=documentPartContract(identity,0,manifest),last=documentPartContract(identity,1,manifest);
    expect(first.size).toBe(documentUploadChunkBytes);expect(last.size).toBe(10);expect(first.context).not.toBe(last.context);for(const key of["organizationId","documentId","admissionId"]as const)expect(documentPartContract({...identity,[key]:randomUUID()},0,manifest).context).not.toBe(first.context);
    expect(documentPartContract({...identity,sha256:"d".repeat(64)},0,manifest).context).not.toBe(first.context);
  });
  it("requires an explicit transport budget for policies that permit larger files",()=>{
    const policy={source:"NATIVE_DOCUMENT_ARCHIVE",types:[{key:"agreement",labels:{en:"Agreement",fr:"Convention",ar:"اتفاقية"},sources:["PROPERTY"],privacy:["operational"],content_types:["application/pdf"],max_bytes:6*1024*1024}],encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",upload_admission:{window_seconds:60,max_requests:10},storage_url_seconds:30};
    expect(documentArchivePolicySchema.safeParse(policy).success).toBe(false);expect(documentArchivePolicySchema.safeParse({...policy,upload_transport:{window_seconds:60,max_requests:100}}).success).toBe(true);
  });
  it("rejects a premature completion or a file acknowledgement redirected to another original document",()=>{
    const documentId=randomUUID(),expected={fileName:"original.pdf",contentType:"application/pdf",fileSize:100,sha256:"a".repeat(64),parts:null},version={id:randomUUID(),documentId,number:1,title:"Original",...expected,supersedesId:null,supersededById:null,effectiveFrom:null,createdAt:"2026-11-06T00:00:00.000Z",createdBy:randomUUID(),reason:"Actual immutable original reason"};
    const{parts:_parts,...file}=version;expect(_parts).toBe(null);const receipt={recorded:true,id:randomUUID(),documentId,idempotencyKey:randomUUID(),state:"COMPLETE",complete:true,version:file,expected};expect(documentUploadAdmissionSchema.safeParse(receipt).success).toBe(true);
    expect(documentUploadAdmissionSchema.safeParse({...receipt,complete:false}).success).toBe(false);expect(documentUploadAdmissionSchema.safeParse({...receipt,version:null}).success).toBe(false);expect(documentUploadAdmissionSchema.safeParse({...receipt,documentId:randomUUID()}).success).toBe(false);expect(documentUploadAdmissionSchema.safeParse({...receipt,expected:{...expected,sha256:"b".repeat(64)}}).success).toBe(false);
  });
});
