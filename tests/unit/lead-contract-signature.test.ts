import {randomBytes,randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeSignatureProtocol,nativeSignatureRecipientProtocol,nativeSignatureSnapshotSchema,nativeSignatureCommandSchema} from "@/modules/documents/domain/document-signature-command";
import {sealNativeSignatureRecipient,openNativeSignatureRecipient} from "@/modules/documents/infrastructure/document-signature-recipient-payload";

function snapshot(kind:"LEAD"|"OWNER"="LEAD"){
 const source={kind,id:randomUUID()},reference={...source},instanceId=randomUUID(),versionId=randomUUID(),command={instanceId,documentVersionId:versionId,recipients:[reference],idempotencyKey:randomUUID(),reviewFingerprint:"b".repeat(64),reason:"Actual retained native contract signature intent"};
 return{protocol:nativeSignatureProtocol,schemaVersion:1,command,commandHash:commandFingerprint(command),document:{id:randomUUID(),instanceId,versionId,admissionId:randomUUID(),sha256:"c".repeat(64),byteSize:256,locale:"fr",source},archiveFingerprint:"d".repeat(64),nativeSourceFingerprint:"e".repeat(64),archivePolicy:{id:randomUUID(),version:1,value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:30,upload_admission:{window_seconds:3600,max_requests:100},types:[{key:"approved_contract",labels:{en:"Approved contract",fr:"Contrat approuvé",ar:"عقد معتمد"},sources:[kind],privacy:["sensitive"],content_types:["application/pdf"],max_bytes:1048576}]}},...kind==="LEAD"?{leadContractPolicy:{id:randomUUID(),version:1,contractTypeKeys:["approved_contract"]}}:{},recipients:[{reference,identityHash:commandFingerprint(reference),fingerprint:"f".repeat(64)}]};
}
describe("native acquisition contract signature intent",()=>{
 it("requires the retained contract approval and its actual owning lead signer",()=>{
  const original=snapshot();expect(nativeSignatureSnapshotSchema.safeParse(original).success).toBe(true);const missing={...original,leadContractPolicy:undefined};expect(nativeSignatureSnapshotSchema.safeParse(missing).success).toBe(false);
  for(const reference of[{kind:"LEAD",id:randomUUID()},{kind:"OWNER",id:original.document.source.id}]){const altered={...original,command:{...original.command,recipients:[reference]},recipients:[{...original.recipients[0],reference}]};expect(nativeSignatureSnapshotSchema.safeParse(altered).success).toBe(false);}
 });
 it("preserves the original legacy owner protocol without adding or reinterpreting metadata",()=>{
  const original=snapshot("OWNER");expect(nativeSignatureSnapshotSchema.parse(original)).toEqual(original);const source={kind:"LEAD",id:original.document.source.id};expect(nativeSignatureSnapshotSchema.safeParse({...original,command:{...original.command,recipients:[source]},recipients:[{...original.recipients[0],reference:source}]}).success).toBe(false);
 });
 it("accepts only native references and refuses caller-supplied lead contacts or authority",()=>{
  const original=snapshot().command;expect(nativeSignatureCommandSchema.safeParse(original).success).toBe(true);for(const data of[{displayName:"Claimed owner"},{email:"claimed@example.test"},{leadContractPolicy:{id:randomUUID()}},{authorizationCap:{}},{amount:"9007199254740993.07"}])expect(nativeSignatureCommandSchema.safeParse({...original,...data}).success).toBe(false);expect(nativeSignatureCommandSchema.safeParse({...original,recipients:[{...original.recipients[0],email:"claimed@example.test"}]}).success).toBe(false);
 });
 it("binds the encrypted actual lead identity to its tenant,signature,recipient and retained source",()=>{
  const env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"lead-contract-owned:"+randomBytes(32).toString("base64")},identity={organizationId:randomUUID(),signatureId:randomUUID(),recipientId:randomUUID(),reference:{kind:"LEAD" as const,id:randomUUID()},fingerprint:"a".repeat(64)},payload:Parameters<typeof sealNativeSignatureRecipient>[0]={protocol:nativeSignatureRecipientProtocol,schemaVersion:1,identity,displayName:"Actual retained propriétaire",email:"actual-lead@example.test"},cipher=sealNativeSignatureRecipient(payload,env);expect(Buffer.from(cipher).includes(Buffer.from(payload.email))).toBe(false);expect(openNativeSignatureRecipient(identity,cipher,env)).toEqual(payload);
  for(const changed of[{organizationId:randomUUID()},{signatureId:randomUUID()},{recipientId:randomUUID()},{reference:{kind:"LEAD" as const,id:randomUUID()}},{reference:{kind:"OWNER" as const,id:identity.reference.id}},{fingerprint:"b".repeat(64)}])expect(()=>openNativeSignatureRecipient({...identity,...changed},cipher,env)).toThrow("document_source_changed");expect(openNativeSignatureRecipient(identity,cipher,env)).toEqual(payload);
 });
});
