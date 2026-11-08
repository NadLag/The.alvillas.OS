import {randomBytes,randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {canonicalLeadProfileCommand,canonicalLeadProfileDraft,configuredLeadProfile,leadProfilePolicySchema} from "@/modules/crm/domain/lead-profile";
import {encryptLeadProfilePayload,decryptLeadProfilePayload,type LeadProfilePayloadBinding} from "@/modules/crm/domain/lead-profile-payload";
import {parseConfiguredLeadCapture} from "@/modules/crm/domain/lead-capture";
import {nativeLeadInput,nativeLeadPolicy,nativeWebsiteLeadInput} from "../integration/support/lead-fixture";

const draft=()=>({leadId:randomUUID(),previousRevisionId:null,sourceKey:"assessment",locale:"fr" as const,fields:nativeLeadInput().fields});
const command=()=>({...draft(),idempotencyKey:randomUUID(),reviewFingerprint:"f".repeat(64),reason:"Reviewed correction of entered acquisition details"});
const binding=(value:ReturnType<typeof command>):LeadProfilePayloadBinding=>({organizationId:randomUUID(),leadId:value.leadId,revisionId:randomUUID(),previousRevisionId:value.previousRevisionId,createdBy:randomUUID(),policyId:randomUUID(),policyVersion:1,capturePolicyId:randomUUID(),capturePolicyVersion:1,commandKey:value.idempotencyKey});
const env=()=>({NODE_ENV:"test" as const,ENCRYPTION_KEYS:"profile:"+randomBytes(32).toString("base64")});
describe("private reviewed lead profile corrections",()=>{
  it.each(["en","fr","ar"]as const)("preserves all configured %s fields including zero bedrooms",locale=>{
    const value={...draft(),locale,fields:{...draft().fields,bedrooms:0,ownerContact:"  Proprie\u0301taire  "}};expect(configuredLeadProfile(value,"MANUAL",nativeLeadPolicy())).toMatchObject({locale,fields:{bedrooms:0,ownerContact:"Propriétaire"}});
  });
  it("uses one stable command projection for reordered fields, uppercase UUIDs and set-valued OTA choices",()=>{
    const value={...command(),fields:{...draft().fields,currentOtaKeys:["second","first"]}},reordered={...Object.fromEntries(Object.entries(value).reverse()),leadId:value.leadId.toUpperCase(),idempotencyKey:value.idempotencyKey.toUpperCase(),fields:{...Object.fromEntries(Object.entries(value.fields).reverse()),currentOtaKeys:["first","second"]}};
    expect(JSON.stringify(canonicalLeadProfileCommand(reordered))).toBe(JSON.stringify(canonicalLeadProfileCommand(value)));
  });
  it.each(["organizationId","actorId","personId","ownerId","status","stage","assignedRepresentativeId","completed","policyId"])("rejects caller-controlled %s",key=>{
    expect(()=>canonicalLeadProfileDraft({...draft(),[key]:randomUUID()})).toThrow();expect(()=>canonicalLeadProfileDraft({...draft(),fields:{...draft().fields,[key]:randomUUID()}})).toThrow();
  });
  it.each(["source","contact","required","property","rental","ota","referral"])("enforces the same configured %s rule as capture",kind=>{
    const value=draft();if(kind==="source")value.sourceKey="retired";else if(kind==="contact")delete value.fields.email;else if(kind==="required")delete value.fields.location;else if(kind==="property")value.fields.propertyTypeKey="retired";else if(kind==="rental")value.fields.currentRentalStatusKey="retired";else if(kind==="ota")value.fields.currentOtaKeys=["retired"];else value.fields.referralContact={name:"Private unrelated referral"};
    expect(()=>configuredLeadProfile(value,"MANUAL",nativeLeadPolicy())).toThrow();
  });
  it("keeps original website consent immutable while requiring fresh consent for a new capture",()=>{
    const original=nativeWebsiteLeadInput(),policy=nativeLeadPolicy({website_notice:{approval_reference:"new explicitly approved notice",notice_sha256:"b".repeat(64)}});
    expect(()=>parseConfiguredLeadCapture(original,policy)).toThrow();expect(()=>configuredLeadProfile({...draft(),fields:original.fields},"WEBSITE",policy)).not.toThrow();expect(original.websiteAcknowledgement?.noticeSha256).toBe("a".repeat(64));
  });
  it("bounds actual UTF8 command bytes, including the retained private correction reason",()=>{
    const value={...command(),fields:{...draft().fields,notes:"界".repeat(8000),objectives:"界".repeat(8000)}};expect(()=>canonicalLeadProfileCommand(value)).toThrow();
  });
  it.each([{}, {source:"NATIVE_IMMUTABLE_LEAD_PROFILE",history:"APPEND_ONLY_REVIEWED_PROFILE_CORRECTIONS",admission:{requests:0,window_seconds:3600}}])("never invents an admission policy",policy=>expect(()=>leadProfilePolicySchema.parse(policy)).toThrow());
  it("encrypts private values and reasons using the existing retained platform key ring",()=>{
    const value=command(),identity=binding(value),keys=env(),cipher=encryptLeadProfilePayload(value,identity,keys),rotated={...keys,ENCRYPTION_KEYS:"replacement:"+randomBytes(32).toString("base64")+","+keys.ENCRYPTION_KEYS};
    expect(Buffer.from(cipher).includes(Buffer.from(value.fields.email!))).toBe(false);expect(Buffer.from(cipher).includes(Buffer.from(value.reason))).toBe(false);expect(decryptLeadProfilePayload(cipher,identity,rotated)).toEqual(canonicalLeadProfileCommand(value));
  });
  it.each(["organizationId","leadId","revisionId","previousRevisionId","createdBy","policyId","capturePolicyId","commandKey"]as const)("binds ciphertext to its actual %s",key=>{
    const value=command(),identity=binding(value),keys=env(),cipher=encryptLeadProfilePayload(value,identity,keys);expect(()=>decryptLeadProfilePayload(cipher,{...identity,[key]:randomUUID()},keys)).toThrow();
  });
  it.each(["policyVersion","capturePolicyVersion"]as const)("binds ciphertext to its actual %s",key=>{
    const value=command(),identity=binding(value),keys=env();expect(()=>decryptLeadProfilePayload(encryptLeadProfilePayload(value,identity,keys),{...identity,[key]:2},keys)).toThrow();
  });
  it("rejects missing or malformed active keys and mismatched command ownership",()=>{
    const value=command(),identity=binding(value);expect(()=>encryptLeadProfilePayload(value,identity,{NODE_ENV:"test"})).toThrow();expect(()=>encryptLeadProfilePayload(value,identity,{NODE_ENV:"test",ENCRYPTION_KEYS:"legacy-short-key"})).toThrow();expect(()=>encryptLeadProfilePayload(value,{...identity,leadId:randomUUID()},env())).toThrow();
  });
});
