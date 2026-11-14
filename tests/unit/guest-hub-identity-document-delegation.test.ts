import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {signBytes} from "@/platform/auth/secret-encryption";
import {guestHubIdentityDocumentDelegationBindingSchema,signGuestHubIdentityDocumentDelegation,verifyGuestHubIdentityDocumentDelegation} from "@/modules/guest-hub/domain/guest-hub-identity-document-delegation";
import {GuestHubIdentityDocumentConfigurationError} from "@/modules/guest-hub/domain/guest-hub-identity-document-policy";
import {ownedGuestHubIdentityDocumentDelegation as binding} from "../integration/support/guest-hub-identity-document-delegation";

const original="original:"+Buffer.alloc(32,17).toString("base64"),rotated="rotated:"+Buffer.alloc(32,29).toString("base64"),env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:original};
function reverseObjectKeys(value:unknown):unknown{if(Array.isArray(value))return value.map(reverseObjectKeys);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).reverse().map(([key,entry])=>[key,reverseObjectKeys(entry)]));return value;}
describe("native identity document authority delegation signatures",()=>{
 it("authenticates closed tenant, creator, grant, authority and canonical policy metadata across JSONB object ordering",()=>{
  const original=binding(),signed=signGuestHubIdentityDocumentDelegation(original,env);expect(signed.version).toBe("original");expect(verifyGuestHubIdentityDocumentDelegation(original,signed.version,signed.signature,env)).toBe(true);expect(guestHubIdentityDocumentDelegationBindingSchema.parse(reverseObjectKeys(original))).toEqual(original);expect(verifyGuestHubIdentityDocumentDelegation(reverseObjectKeys(original),signed.version,signed.signature,env)).toBe(true);
 });
 it("rejects changed source grants, permissions, scope, native archive bounds and retained legal references",()=>{
  const original=binding(),signed=signGuestHubIdentityDocumentDelegation(original,env),changed=[{...original,grantId:randomUUID()},{...original,grantFingerprint:"b".repeat(64)},{...original,authorizationCap:{...original.authorizationCap,permissions:[...original.authorizationCap.permissions,"documents:export"]}},{...original,authorizationCap:{...original.authorizationCap,scopes:[{organizationId:original.organizationId,scopeType:"organization"}]}},{...original,archivePolicy:{...original.archivePolicy,value:{...original.archivePolicy.value,types:original.archivePolicy.value.types.map(type=>({...type,max_bytes:type.max_bytes+1}))}}},{...original,retentionPolicy:{...original.retentionPolicy,value:{...original.retentionPolicy.value,tags:original.retentionPolicy.value.tags.map(tag=>({...tag,policy_references:["Another retention purpose"]}))}}}];for(const candidate of changed)expect(verifyGuestHubIdentityDocumentDelegation(candidate,signed.version,signed.signature,env)).toBe(false);
 });
 it("fails closed before signing another tenant's authority, creator or canonical policy",()=>{
  const original=binding();for(const candidate of[{...original,organizationId:randomUUID()},{...original,createdBy:randomUUID()},{...original,archivePolicy:{...original.archivePolicy,organizationId:randomUUID()}},{...original,retentionPolicy:{...original.retentionPolicy,organizationId:randomUUID()}}]){expect(guestHubIdentityDocumentDelegationBindingSchema.safeParse(candidate).success).toBe(false);expect(()=>signGuestHubIdentityDocumentDelegation(candidate,env)).toThrow(GuestHubIdentityDocumentConfigurationError);}
 });
 it("retains an original delegation under rotated keys and rejects a removed or substituted signing key",()=>{
  const originalBinding=binding(),signed=signGuestHubIdentityDocumentDelegation(originalBinding,env);expect(verifyGuestHubIdentityDocumentDelegation(originalBinding,signed.version,signed.signature,{NODE_ENV:"test",ENCRYPTION_KEYS:rotated+","+original})).toBe(true);expect(verifyGuestHubIdentityDocumentDelegation(originalBinding,signed.version,signed.signature,{NODE_ENV:"test",ENCRYPTION_KEYS:rotated})).toBe(false);expect(verifyGuestHubIdentityDocumentDelegation(originalBinding,"rotated",signed.signature,{NODE_ENV:"test",ENCRYPTION_KEYS:rotated+","+original})).toBe(false);expect(verifyGuestHubIdentityDocumentDelegation(originalBinding,signed.version,signed.signature.subarray(1),env)).toBe(false);
 });
 it("cannot reuse the retained form-grant signing purpose or admit personal document content into its metadata",()=>{
  const original=binding(),wrong=signBytes(Buffer.from(JSON.stringify(original)),"alvillas.guest-hub.form-grant.v1",env);expect(verifyGuestHubIdentityDocumentDelegation(original,wrong.version,wrong.signature,env)).toBe(false);for(const extra of[{identityNumber:"unapproved"},{fileName:"unapproved"},{capability:"unapproved"},{storageUrl:"https://outside.example.test/private"}])expect(guestHubIdentityDocumentDelegationBindingSchema.safeParse({...original,...extra}).success).toBe(false);
 });
 it("requires an explicit valid private key ring and never substitutes the authentication secret",()=>{
  const originalBinding=binding(),signed=signGuestHubIdentityDocumentDelegation(originalBinding,env);for(const unavailable of[{}, {AUTH_SECRET:"unavailable-test-only-fallback"},{ENCRYPTION_KEYS:"original:invalid"},{ENCRYPTION_KEYS:original+","+original}]){const isolated={NODE_ENV:"test" as const,...unavailable};expect(()=>signGuestHubIdentityDocumentDelegation(originalBinding,isolated)).toThrow(GuestHubIdentityDocumentConfigurationError);expect(verifyGuestHubIdentityDocumentDelegation(originalBinding,signed.version,signed.signature,isolated)).toBe(false);}
 });
});
