import {randomBytes,randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {canonicalLeadConversionDraft,canonicalLeadConversionCommand,leadConversionPolicySchema} from "@/modules/crm/domain/lead-conversion";
import {encryptLeadConversionPayload,decryptLeadConversionPayload,type LeadConversionPayloadBinding} from "@/modules/crm/domain/lead-conversion-payload";

const draft=()=>({leadId:randomUUID(),profileRevisionId:null,signedStageId:randomUUID(),target:{mode:"CREATE" as const}});
const command=()=>({...draft(),idempotencyKey:randomUUID(),reviewFingerprint:"a".repeat(64),reason:"Explicit reviewed conversion of the original signed acquisition"});
const binding=(value:ReturnType<typeof command>):LeadConversionPayloadBinding=>({organizationId:randomUUID(),leadId:value.leadId,conversionId:randomUUID(),ownerId:randomUUID(),createdBy:randomUUID(),commandKey:value.idempotencyKey,policyId:randomUUID(),policyVersion:3});
const originalOwner={displayName:"Propriétaire original",email:"original@example.test",phone:null,preferredLocale:"fr" as const};
const env=()=>({NODE_ENV:"test" as const,ENCRYPTION_KEYS:"conversion:"+randomBytes(32).toString("base64")});
describe("original-bound Lead to Owner commands",()=>{
 it.each(["ownerContact","email","phone","ownerName","financialSettings","payoutMethods","organizationId","actorId","signed","completed","policyId"])("rejects caller-supplied %s instead of using it as native source evidence",key=>{
  expect(()=>canonicalLeadConversionDraft({...draft(),[key]:"untrusted"})).toThrow();
 });
 it("requires explicit Owner linking and rejects hidden mutations in either target",()=>{
  const value=draft(),ownerId=randomUUID();expect(canonicalLeadConversionDraft({...value,target:{mode:"LINK",ownerId}}).target).toEqual({mode:"LINK",ownerId});
  for(const target of[{mode:"LINK"},{mode:"LINK",ownerId,overwrite:true},{mode:"CREATE",ownerId},{mode:"CREATE",email:"injected@example.test"}])expect(()=>canonicalLeadConversionDraft({...value,target})).toThrow();
 });
 it("canonically equates reordered input and uppercase UUID references for exact replay",()=>{
  const value=command(),reordered={...Object.fromEntries(Object.entries(value).reverse()),leadId:value.leadId.toUpperCase(),signedStageId:value.signedStageId.toUpperCase(),idempotencyKey:value.idempotencyKey.toUpperCase()};expect(JSON.stringify(canonicalLeadConversionCommand(reordered))).toBe(JSON.stringify(canonicalLeadConversionCommand(value)));
 });
 it("does not invent eligibility, admission budgets or an enabled creation/link mode",()=>{
  for(const value of[{}, {source:"NATIVE_REVIEWED_LEAD_OWNER_CONVERSION",history:"APPEND_ONLY_ORIGINAL_CONVERSION",prerequisite:"NATIVE_SIGNED_STAGE_AND_COMPLETED_ARCHIVE",modes:[],admission:{requests:10,window_seconds:60}}, {source:"NATIVE_REVIEWED_LEAD_OWNER_CONVERSION",history:"APPEND_ONLY_ORIGINAL_CONVERSION",prerequisite:"CALLER_SIGNED_FLAG",modes:["CREATE"],admission:{requests:10,window_seconds:60}}])expect(()=>leadConversionPolicySchema.parse(value)).toThrow();
 });
 it("retains encrypted private identity and reason across key rotation",()=>{
  const value=command(),identity=binding(value),keys=env(),cipher=encryptLeadConversionPayload({command:value,originalOwner},identity,keys);
  for(const text of[originalOwner.displayName,originalOwner.email,value.reason])expect(Buffer.from(cipher).includes(Buffer.from(text))).toBe(false);
  expect(decryptLeadConversionPayload(cipher,identity,{...keys,ENCRYPTION_KEYS:"new:"+randomBytes(32).toString("base64")+","+keys.ENCRYPTION_KEYS})).toEqual({command:canonicalLeadConversionCommand(value),originalOwner});
 });
 it.each(["organizationId","leadId","conversionId","ownerId","createdBy","commandKey","policyId"]as const)("rejects transplanted ciphertext under a different %s",key=>{
  const value=command(),identity=binding(value),keys=env(),cipher=encryptLeadConversionPayload({command:value,originalOwner},identity,keys);expect(()=>decryptLeadConversionPayload(cipher,{...identity,[key]:randomUUID()},keys)).toThrow();
 });
 it("binds the retained policy version and detects actual ciphertext tampering",()=>{
  const value=command(),identity=binding(value),keys=env(),cipher=Buffer.from(encryptLeadConversionPayload({command:value,originalOwner},identity,keys));expect(()=>decryptLeadConversionPayload(cipher,{...identity,policyVersion:4},keys)).toThrow();cipher[cipher.length-1]^=1;expect(()=>decryptLeadConversionPayload(cipher,identity,keys)).toThrow();
 });
 it("rejects missing keys, another Lead and an existing-Owner substitution before encryption",()=>{
  const value=command(),identity=binding(value),keys=env();expect(()=>encryptLeadConversionPayload({command:value,originalOwner},identity,{NODE_ENV:"test"})).toThrow();expect(()=>encryptLeadConversionPayload({command:{...value,leadId:randomUUID()},originalOwner},identity,keys)).toThrow();expect(()=>encryptLeadConversionPayload({command:{...value,target:{mode:"LINK",ownerId:randomUUID()}},originalOwner},identity,keys)).toThrow();
 });
});
