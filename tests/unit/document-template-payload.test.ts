import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeDocumentTemplate } from "@/modules/documents/domain/document-template";
import { documentTemplateMediaType } from "@/modules/documents/domain/document-template-format";
import { sealDocumentTemplatePayload, openDocumentTemplatePayload, type TemplatePayloadIdentity } from "@/modules/documents/infrastructure/document-template-payload";

function fixture(){
  const definition={schemaVersion:1,templateKey:"owner_agreement",locale:"fr" as const,title:"Convention {{property}}",variables:[{key:"property",kind:"TEXT"}],blocks:[{kind:"PARAGRAPH",text:"Texte original privé {{property}}. النص الأصلي"}]},bytes=encodeDocumentTemplate(definition),
    identity:TemplatePayloadIdentity={organizationId:randomUUID(),documentId:randomUUID(),admissionId:randomUUID(),contentType:documentTemplateMediaType,fileSize:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),templateKey:definition.templateKey,locale:definition.locale},env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"template-original:"+randomBytes(32).toString("base64")};
  return{definition,bytes,identity,env};
}
describe("durable authenticated template intent payload",()=>{
  it("retains exact original UTF-8 in authenticated ciphertext rather than plaintext",()=>{
    const f=fixture(),cipher=sealDocumentTemplatePayload(f.identity,f.bytes,f.env);expect(Buffer.from(cipher).includes(Buffer.from(f.bytes))).toBe(false);expect(cipher.length).toBeGreaterThan(f.bytes.length);expect(cipher.length).toBeLessThanOrEqual(f.bytes.length+256);
    expect(openDocumentTemplatePayload(f.identity,cipher,f.env)).toEqual(Buffer.from(f.bytes));
  });
  it.each(["organizationId","documentId","admissionId"] as const)("binds durable body to its original %s",field=>{
    const f=fixture(),cipher=sealDocumentTemplatePayload(f.identity,f.bytes,f.env);expect(()=>openDocumentTemplatePayload({...f.identity,[field]:randomUUID()},cipher,f.env)).toThrow("document_storage_unavailable");
  });
  it.each(["fileSize","sha256","contentType","templateKey","locale"] as const)("refuses substituted original %s",field=>{
    const f=fixture(),cipher=sealDocumentTemplatePayload(f.identity,f.bytes,f.env),changed={...f.identity,...field==="fileSize"?{fileSize:f.identity.fileSize+1}:field==="sha256"?{sha256:"0".repeat(64)}:field==="contentType"?{contentType:"application/json" as const}:field==="templateKey"?{templateKey:"other_agreement"}:{locale:"en" as const}};
    expect(()=>openDocumentTemplatePayload(changed,cipher,f.env)).toThrow("document_storage_unavailable");
  });
  it("refuses altered ciphertext and a different original body before persistence",()=>{
    const f=fixture(),cipher=sealDocumentTemplatePayload(f.identity,f.bytes,f.env),changed=Buffer.from(cipher);changed[changed.length-1]^=1;
    expect(()=>openDocumentTemplatePayload(f.identity,changed,f.env)).toThrow("document_storage_unavailable");expect(()=>sealDocumentTemplatePayload(f.identity,new TextEncoder().encode("different original"),f.env)).toThrow("document_source_changed");
  });
  it("retains historical key access across rotation and refuses a missing original key",()=>{
    const f=fixture(),cipher=sealDocumentTemplatePayload(f.identity,f.bytes,f.env),next="template-next:"+randomBytes(32).toString("base64"),rotated={...f.env,ENCRYPTION_KEYS:next+","+f.env.ENCRYPTION_KEYS};
    expect(openDocumentTemplatePayload(f.identity,cipher,rotated)).toEqual(Buffer.from(f.bytes));expect(()=>openDocumentTemplatePayload(f.identity,cipher,{...f.env,ENCRYPTION_KEYS:next})).toThrow("document_storage_unavailable");
  });
  it("requires persistent encryption keys even when an authentication secret is available",()=>{
    const f=fixture(),env={NODE_ENV:"test" as const,AUTH_SECRET:"not-a-document-encryption-key"};expect(()=>sealDocumentTemplatePayload(f.identity,f.bytes,env)).toThrow("document_configuration_unavailable");
    const cipher=sealDocumentTemplatePayload(f.identity,f.bytes,f.env);expect(()=>openDocumentTemplatePayload(f.identity,cipher,env)).toThrow("document_configuration_unavailable");
  });
});
