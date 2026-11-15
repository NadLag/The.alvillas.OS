import {randomBytes,randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {signBytes} from "@/platform/auth/secret-encryption";
import {documentUploadChunkBytes} from "@/modules/documents";
import {guestHubIdentityDocumentReviewBindingSchema,guestHubIdentityDocumentPayloadBindingSchema,guestHubIdentityDocumentManifestSchema,guestHubPrivateIdentityDocumentSchema,guestHubStoredIdentityDocumentReview} from "@/modules/guest-hub/domain/guest-hub-identity-document-private-contract";
import {signGuestHubIdentityDocumentReview,verifyGuestHubIdentityDocumentReview,signGuestHubIdentityDocumentCommand,verifyGuestHubIdentityDocumentCommand,encryptGuestHubIdentityDocumentCapture,decryptGuestHubIdentityDocumentCapture} from "@/modules/guest-hub/domain/guest-hub-identity-document-private";
import {GuestHubIdentityDocumentConfigurationError,GuestHubIdentityDocumentConflictError} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";

const original=randomBytes(32).toString("base64"),replacement=randomBytes(32).toString("base64");
const env:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"identity-original:"+original};
function fixture(){
 const review=guestHubIdentityDocumentReviewBindingSchema.parse({
  protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_REVIEW_V1",organizationId:randomUUID(),linkId:randomUUID(),reservationId:randomUUID(),propertyId:randomUUID(),guestId:randomUUID(),grantId:randomUUID(),
  grantFingerprint:"a".repeat(64),policyFingerprint:"b".repeat(64),sourceFingerprint:"c".repeat(64),formFingerprint:"d".repeat(64),previousCaptureId:null,idempotencyKey:randomUUID(),acknowledged:true,
  files:[{kind:"PASSPORT",part:"IDENTITY_PAGE",contentType:"image/jpeg",fileSize:1024,sha256:"e".repeat(64)}]
 });
 const token=signGuestHubIdentityDocumentReview(review,env),command=signGuestHubIdentityDocumentCommand(review,token,env);
 const manifest=guestHubIdentityDocumentManifestSchema.parse([{id:randomUUID(),kind:"PASSPORT",part:"IDENTITY_PAGE"}]);
 const binding=guestHubIdentityDocumentPayloadBindingSchema.parse({
  protocol:"NATIVE_GUEST_IDENTITY_DOCUMENT_CAPTURE_V1",id:randomUUID(),organizationId:review.organizationId,linkId:review.linkId,reservationId:review.reservationId,propertyId:review.propertyId,guestId:review.guestId,grantId:review.grantId,
  previousId:null,version:1,commandKey:review.idempotencyKey,commandHash:command.commandHash,commandKeyVersion:command.keyVersion,grantFingerprint:review.grantFingerprint,formFingerprint:review.formFingerprint,
  manifestFingerprint:jsonbFingerprint(manifest),policyId:randomUUID(),policyVersion:1,policyFingerprint:review.policyFingerprint,sourceFingerprint:review.sourceFingerprint,createdAt:"2026-11-14T23:00:00.000Z"
 });
 const payload=guestHubPrivateIdentityDocumentSchema.parse({schemaVersion:1,files:review.files,acknowledged:true,reviewFingerprint:token});return{review,token,command,manifest,binding,payload};
}

describe("purpose-bound encrypted native identity capture manifests",()=>{
 it("authenticates the exact original source, file descriptor, predecessor, nonce and acknowledgement",()=>{
  const f=fixture();expect(verifyGuestHubIdentityDocumentReview(f.review,f.token,env)).toBe(true);
  for(const changed of [{organizationId:randomUUID()},{linkId:randomUUID()},{reservationId:randomUUID()},{propertyId:randomUUID()},{guestId:randomUUID()},{grantId:randomUUID()},{grantFingerprint:"f".repeat(64)},{formFingerprint:"f".repeat(64)},{policyFingerprint:"f".repeat(64)},{sourceFingerprint:"f".repeat(64)},{previousCaptureId:randomUUID()},{idempotencyKey:randomUUID()},{acknowledged:false},{files:[{...f.review.files[0],sha256:"f".repeat(64)}]},{files:[{...f.review.files[0],part:"BACK"}]}]){
   const candidate={...f.review,...changed};expect(()=>verifyGuestHubIdentityDocumentReview(candidate,f.token,env)).toThrow(GuestHubIdentityDocumentConflictError);expect(verifyGuestHubIdentityDocumentCommand(candidate,f.token,f.command.keyVersion,f.command.commandHash,env)).toBe(false);
  }
 });
 it("recovers exact private descriptors through the existing AEAD boundary without exposing their original hashes",()=>{
  const f=fixture(),cipher=encryptGuestHubIdentityDocumentCapture(f.payload,f.binding,f.manifest,env);expect(cipher.includes(Buffer.from(f.review.files[0].sha256))).toBe(false);expect(decryptGuestHubIdentityDocumentCapture(cipher,f.binding,f.manifest,env)).toEqual(f.payload);expect(guestHubStoredIdentityDocumentReview(f.binding,f.payload)).toEqual(f.review);
 });
 it("binds encrypted history to the immutable native header and actual file-manifest fingerprint",()=>{
  const f=fixture(),cipher=encryptGuestHubIdentityDocumentCapture(f.payload,f.binding,f.manifest,env);
  for(const changed of [{id:randomUUID()},{organizationId:randomUUID()},{linkId:randomUUID()},{reservationId:randomUUID()},{propertyId:randomUUID()},{guestId:randomUUID()},{grantId:randomUUID()},{commandKey:randomUUID()},{commandHash:"f".repeat(64)},{policyId:randomUUID()},{policyVersion:2},{formFingerprint:"f".repeat(64)},{manifestFingerprint:jsonbFingerprint([{...f.manifest[0],id:randomUUID()}])},{previousId:randomUUID(),version:2},{createdAt:"2026-11-14T23:00:01.000Z"}])expect(()=>decryptGuestHubIdentityDocumentCapture(cipher,{...f.binding,...changed},f.manifest,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
  const damaged=Buffer.from(cipher);damaged[damaged.length-1]^=1;expect(()=>decryptGuestHubIdentityDocumentCapture(damaged,f.binding,f.manifest,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
 });
 it("recovers original ciphertexts and commitments under retained rotated keys and rejects removal",()=>{
  const f=fixture(),cipher=encryptGuestHubIdentityDocumentCapture(f.payload,f.binding,f.manifest,env),rotated={...env,ENCRYPTION_KEYS:"identity-current:"+replacement+",identity-original:"+original},removed={...env,ENCRYPTION_KEYS:"identity-current:"+replacement};
  expect(decryptGuestHubIdentityDocumentCapture(cipher,f.binding,f.manifest,rotated)).toEqual(f.payload);expect(verifyGuestHubIdentityDocumentCommand(f.review,f.token,f.command.keyVersion,f.command.commandHash,rotated)).toBe(true);expect(()=>decryptGuestHubIdentityDocumentCapture(cipher,f.binding,f.manifest,removed)).toThrow(GuestHubIdentityDocumentConfigurationError);
  for(const unavailable of [{NODE_ENV:"test"},{NODE_ENV:"test",AUTH_SECRET:"No identity fallback"},{NODE_ENV:"test",ENCRYPTION_KEYS:"weak:invalid"}]as const)expect(()=>encryptGuestHubIdentityDocumentCapture(f.payload,f.binding,f.manifest,unavailable)).toThrow(GuestHubIdentityDocumentConfigurationError);
 });
 it("cannot reuse profile, stay-details or authority-delegation signing purposes",()=>{
  const f=fixture();for(const purpose of ["alvillas.guest-hub.profile.review.v1","alvillas.guest-hub.stay-details.review.v1","alvillas.guest-hub.identity-document-delegation.v1"]){const signed=signBytes(Buffer.from(JSON.stringify(f.review)),purpose,env),token="guest-identity-documents-review-v1."+Buffer.from(signed.version).toString("base64url")+"."+signed.signature.toString("base64url");expect(()=>verifyGuestHubIdentityDocumentReview(f.review,token,env)).toThrow(GuestHubIdentityDocumentConflictError);}
  expect(guestHubIdentityDocumentPayloadBindingSchema.safeParse({...f.binding,protocol:"NATIVE_GUEST_PROFILE_PAYLOAD_V1"}).success).toBe(false);expect(()=>verifyGuestHubIdentityDocumentReview(f.review,f.token.replace("identity-documents","stay-details"),env)).toThrow(GuestHubIdentityDocumentConflictError);
 });
 it("keeps unapproved names, numbers, URLs and file bytes out of reviewed and encrypted metadata",()=>{
  const f=fixture();for(const extra of [{fileName:"unapproved-name.jpeg"},{identityNumber:"unapproved"},{storageUrl:"https://outside.example.test/private"},{bytes:[1,2,3]}]){
   expect(()=>signGuestHubIdentityDocumentReview({...f.review,files:[{...f.review.files[0],...extra}]},env)).toThrow(GuestHubIdentityDocumentConfigurationError);expect(()=>encryptGuestHubIdentityDocumentCapture({...f.payload,...extra},f.binding,f.manifest,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
  }
 });
 it("retains every maximum-size canonical chunk descriptor within the bounded private framing",()=>{
  const f=fixture(),fileSize=10*1024*1024,parts={schemaVersion:1 as const,chunkBytes:documentUploadChunkBytes,hashes:Array.from({length:Math.ceil(fileSize/documentUploadChunkBytes)},()=>"e".repeat(64))};
  const files=(["PASSPORT","NATIONAL_ID"]as const).flatMap(kind=>(["IDENTITY_PAGE","FRONT","BACK"]as const).map(part=>({...f.review.files[0],kind,part,fileSize,parts}))),review={...f.review,files},token=signGuestHubIdentityDocumentReview(review,env),command=signGuestHubIdentityDocumentCommand(review,token,env),manifest=files.map(file=>({id:randomUUID(),kind:file.kind,part:file.part})),binding={...f.binding,manifestFingerprint:jsonbFingerprint(manifest),commandHash:command.commandHash,commandKeyVersion:command.keyVersion},payload={...f.payload,files,reviewFingerprint:token};
  const cipher=encryptGuestHubIdentityDocumentCapture(payload,binding,manifest,env);expect(cipher.byteLength).toBeLessThanOrEqual(65536);expect(decryptGuestHubIdentityDocumentCapture(cipher,binding,manifest,env)).toEqual(payload);
 });
 it("requires distinct actual file identities and sides in the native manifest",()=>{
  const f=fixture();expect(guestHubIdentityDocumentManifestSchema.safeParse([f.manifest[0],{...f.manifest[0],id:randomUUID()}]).success).toBe(false);expect(guestHubIdentityDocumentManifestSchema.safeParse([f.manifest[0],{...f.manifest[0],part:"BACK"}]).success).toBe(false);expect(guestHubIdentityDocumentPayloadBindingSchema.safeParse({...f.binding,previousId:randomUUID()}).success).toBe(false);
 });
 it("cannot detach ciphertext or reviewed sides from the actual native file identities",()=>{
  const f=fixture(),cipher=encryptGuestHubIdentityDocumentCapture(f.payload,f.binding,f.manifest,env),changed=[{...f.manifest[0],id:randomUUID()}];
  expect(()=>encryptGuestHubIdentityDocumentCapture(f.payload,f.binding,changed,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
  expect(()=>decryptGuestHubIdentityDocumentCapture(cipher,f.binding,changed,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
  expect(()=>decryptGuestHubIdentityDocumentCapture(cipher,{...f.binding,manifestFingerprint:jsonbFingerprint(changed)},changed,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
  const wrongSide=[{...f.manifest[0],part:"BACK" as const}],binding={...f.binding,manifestFingerprint:jsonbFingerprint(wrongSide)};
  expect(()=>encryptGuestHubIdentityDocumentCapture(f.payload,binding,wrongSide,env)).toThrow(GuestHubIdentityDocumentConfigurationError);
 });
});
