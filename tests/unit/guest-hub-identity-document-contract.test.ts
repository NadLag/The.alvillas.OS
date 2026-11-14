import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {ZodError} from "zod";
import {documentUploadChunkBytes,documentSingleBodyBytes} from "@/modules/documents";
import {guestHubIdentityDocumentDraftSchema,guestHubIdentityDocumentSubmitSchema,guestHubIdentityDocumentRecoverySchema,guestHubIdentityDocumentMaximumJsonBytes,validateGuestHubIdentityDocumentSelection} from "@/modules/guest-hub/domain/guest-hub-identity-document-contract";
import {effectiveGuestHubIdentityDocumentArchive} from "@/modules/guest-hub/domain/guest-hub-identity-document-archive";
import {ownedGuestHubIdentityDocumentPolicy} from "../integration/support/guest-hub-identity-document-policy";
import {ownedGuestHubIdentityDocumentDelegation} from "../integration/support/guest-hub-identity-document-delegation";

const file=()=>({kind:"PASSPORT" as const,part:"IDENTITY_PAGE" as const,contentType:"image/jpeg" as const,fileSize:1024,sha256:"a".repeat(64)});
const draft=()=>({previousCaptureId:null,files:[file()],acknowledged:true});
function policy(){const identity=ownedGuestHubIdentityDocumentPolicy(),delegation=ownedGuestHubIdentityDocumentDelegation();return effectiveGuestHubIdentityDocumentArchive(identity,identity,delegation,delegation.archivePolicy,delegation.retentionPolicy);}
function issues(run:()=>unknown){try{run();throw Error("Expected the selected files to be rejected");}catch(error){if(!(error instanceof ZodError))throw error;return error.issues;}}

describe("private native identity capture descriptors",()=>{
 it("frames every distinct kind and side with maximum canonical multipart hashes inside its dedicated JSON bound",()=>{
  const fileSize=10*1024*1024,parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:Array.from({length:Math.ceil(fileSize/documentUploadChunkBytes)},()=>"b".repeat(64))};
  const files=(["PASSPORT","NATIONAL_ID"] as const).flatMap(kind=>(["IDENTITY_PAGE","FRONT","BACK"] as const).map(part=>({...file(),kind,part,fileSize,parts}))),input={previousCaptureId:randomUUID(),files,acknowledged:true,idempotencyKey:randomUUID(),reviewFingerprint:"c".repeat(64)};
  expect(guestHubIdentityDocumentSubmitSchema.parse(input)).toEqual(input);const size=Buffer.byteLength(JSON.stringify(input));expect(size).toBeGreaterThan(8192);expect(size).toBeLessThan(guestHubIdentityDocumentMaximumJsonBytes);
 });
 it("rejects original filenames, identity numbers, object URLs and file bytes instead of admitting them as capture metadata",()=>{
  for(const extra of[{fileName:"private-name.jpeg"},{identityNumber:"unapproved"},{storageUrl:"https://outside.example.test/private"},{bytes:[1,2,3]}])expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),files:[{...file(),...extra}]}).success).toBe(false);
  expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),guestName:"unapproved"}).success).toBe(false);
 });
 it("requires exact bounded chunk framing above the canonical single-request boundary",()=>{
  const fileSize=documentSingleBodyBytes+1,expected=Math.ceil(fileSize/documentUploadChunkBytes),parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:Array.from({length:expected},()=>"a".repeat(64))};
  expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),files:[{...file(),fileSize}]}).success).toBe(false);
  expect(guestHubIdentityDocumentDraftSchema.parse({...draft(),files:[{...file(),fileSize,parts}]}).files[0].parts?.hashes).toHaveLength(expected);
  for(const changed of[{...parts,hashes:parts.hashes.slice(1)},{...parts,chunkBytes:parts.chunkBytes+1},{...parts,hashes:parts.hashes.map(()=>"invalid")},{...parts,originalName:"unapproved"}])expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),files:[{...file(),fileSize,parts:changed}]}).success).toBe(false);
 });
 it("rejects empty, excessive, duplicate and unbounded file selections",()=>{
  for(const files of[[],Array.from({length:7},file),[file(),{...file(),sha256:"b".repeat(64)}]])expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),files}).success).toBe(false);
  for(const fileSize of[0,-1,1.5,10*1024*1024+1,Number.POSITIVE_INFINITY])expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),files:[{...file(),fileSize}]}).success).toBe(false);
 });
 it("requires an explicit predecessor and an original scoped nonce and fingerprint for submission",()=>{
  expect(guestHubIdentityDocumentDraftSchema.safeParse({files:[file()],acknowledged:true}).success).toBe(false);expect(guestHubIdentityDocumentSubmitSchema.safeParse(draft()).success).toBe(false);
  const input={...draft(),previousCaptureId:randomUUID(),idempotencyKey:randomUUID(),reviewFingerprint:"a".repeat(64)};expect(guestHubIdentityDocumentSubmitSchema.parse(input)).toEqual(input);
  expect(guestHubIdentityDocumentRecoverySchema.parse({idempotencyKey:input.idempotencyKey})).toEqual({idempotencyKey:input.idempotencyKey});expect(guestHubIdentityDocumentRecoverySchema.safeParse(input).success).toBe(false);
 });
 it("admits a complete selection only under the actual effective canonical document constraints",()=>{
  expect(validateGuestHubIdentityDocumentSelection(draft(),policy())).toEqual(draft());
  expect(issues(()=>validateGuestHubIdentityDocumentSelection({...draft(),acknowledged:false},policy()))).toEqual(expect.arrayContaining([expect.objectContaining({path:["acknowledged"],message:"identity_acknowledgement_required"})]));
 });
 it("reports a removed kind or side at the actual selected field without expanding the original grant",()=>{
  const kindIssues=issues(()=>validateGuestHubIdentityDocumentSelection({...draft(),files:[{...file(),kind:"NATIONAL_ID"}]},policy()));
  expect(kindIssues).toEqual(expect.arrayContaining([expect.objectContaining({path:["files",0,"kind"],message:"identity_kind_unavailable"})]));
  const partIssues=issues(()=>validateGuestHubIdentityDocumentSelection({...draft(),files:[{...file(),part:"BACK"}]},policy()));
  expect(partIssues).toEqual(expect.arrayContaining([expect.objectContaining({path:["files",0,"part"],message:"identity_part_unavailable"})]));
 });
 it("enforces the narrower canonical MIME and byte limit even when collection policy permits more",()=>{
  for(const [changed,message,path]of [[{contentType:"image/png"},"identity_content_type_unavailable","contentType"],[{fileSize:1025},"identity_file_too_large","fileSize"]]as const){
   const rejected=issues(()=>validateGuestHubIdentityDocumentSelection({...draft(),files:[{...file(),...changed}]},policy()));
   expect(rejected).toEqual(expect.arrayContaining([expect.objectContaining({path:["files",0,path],message})]));
  }
  expect(guestHubIdentityDocumentDraftSchema.safeParse({...draft(),files:[{...file(),contentType:"text/html"}]}).success).toBe(false);
 });
 it("requires all approved sides of a selected kind and every independently required kind",()=>{
  const effective=policy(),national={...effective.documents[0],kind:"NATIONAL_ID" as const,allowedParts:["FRONT","BACK"] as ("FRONT"|"BACK")[],requiredParts:["FRONT","BACK"] as ("FRONT"|"BACK")[]},both={...effective,documents:[...effective.documents,national],requiredKinds:["NATIONAL_ID" as const]};
  expect(issues(()=>validateGuestHubIdentityDocumentSelection(draft(),both))).toEqual(expect.arrayContaining([expect.objectContaining({message:"identity_required_kind_missing"})]));
  const front={...file(),kind:"NATIONAL_ID" as const,part:"FRONT" as const};expect(issues(()=>validateGuestHubIdentityDocumentSelection({...draft(),files:[front]},both))).toEqual(expect.arrayContaining([expect.objectContaining({message:"identity_required_part_missing",params:{kind:"NATIONAL_ID",part:"BACK"}})]));
  const completed={...draft(),files:[front,{...front,part:"BACK" as const}]};expect(validateGuestHubIdentityDocumentSelection(completed,both)).toEqual(completed);
 });
 it("does not require the sides of an optional kind that was never selected",()=>{
  const effective=policy(),optional={...effective.documents[0],kind:"NATIONAL_ID" as const,allowedParts:["FRONT","BACK"] as ("FRONT"|"BACK")[],requiredParts:["FRONT","BACK"] as ("FRONT"|"BACK")[]};expect(validateGuestHubIdentityDocumentSelection(draft(),{...effective,documents:[...effective.documents,optional]})).toEqual(draft());
 });
});
