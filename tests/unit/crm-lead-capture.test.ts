import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { leadCaptureInputSchema, leadCapturePolicySchema, parseConfiguredLeadCapture, LeadConfigurationError,
  type LeadCaptureInput, type LeadCapturePolicy } from "@/modules/crm/domain/lead-capture";
import { encryptLeadPayload, decryptLeadPayload, type LeadPayloadBinding } from "@/modules/crm/domain/lead-payload";

const label={en:"Assessment request",fr:"Demande d’évaluation",ar:"طلب تقييم"};
const policy=():LeadCapturePolicy=>({
  source:"NATIVE_PRIVATE_LEAD_CAPTURE",channels:["WEBSITE","MANUAL","REFERRAL"],
  sources:[{key:"assessment",label,channels:["WEBSITE","MANUAL","REFERRAL"]}],required_fields:["location"],
  contact_requirement:"PHONE_OR_EMAIL",referral_contact_required:true,property_types:[{key:"villa",label}],rental_statuses:[{key:"available",label}],otas:[{key:"configured_ota",label}],
  processing_approval_reference:"owner-approved-processing-reference",website_notice:{approval_reference:"approved-notice-v1",notice_sha256:"a".repeat(64)},
  encryption:"APP_MANAGED_AUTHENTICATED_ENCRYPTION",history:"APPEND_ONLY_ORIGINAL_CAPTURE",rate_limit:{requests:17,window_seconds:41}
});
const input=():LeadCaptureInput=>({idempotencyKey:randomUUID(),channel:"MANUAL",sourceKey:"assessment",locale:"fr",
  fields:{ownerContact:"Propriétaire privé",email:"private-owner@example.test",location:"Marrakech",bedrooms:0,propertyTypeKey:"villa",currentRentalStatusKey:"available",currentOtaKeys:["configured_ota"],notes:"Note confidentielle"}});
const binding=(value:LeadCaptureInput):LeadPayloadBinding=>({organizationId:randomUUID(),leadId:randomUUID(),createdBy:randomUUID(),policyId:randomUUID(),policyVersion:3,
  channel:value.channel,sourceKey:value.sourceKey,idempotencyKey:value.idempotencyKey});
const keys:NodeJS.ProcessEnv={NODE_ENV:"test",ENCRYPTION_KEYS:"original:"+Buffer.alloc(32,27).toString("base64")};

describe("native private CRM acquisition contracts",()=>{
  it("retains EN, FR and Arabic acquisition details, configured source and exact zero bedrooms",()=>{
    for(const locale of ["en","fr","ar"] as const){const value={...input(),locale,fields:{...input().fields,ownerContact:"  مالك خاص  ",objectives:"évaluation précise"}};
      const result=parseConfiguredLeadCapture(value,policy());expect(result.locale).toBe(locale);expect(result.fields.ownerContact).toBe("مالك خاص");expect(result.fields.bedrooms).toBe(0);expect(result.fields.objectives).toBe("évaluation précise");}
  });
  it("uses canonical field order and NFC to recover the same immutable command from reordered input",()=>{
    const value=input(),first=parseConfiguredLeadCapture({...value,fields:{...value.fields,ownerContact:"Proprie\u0301taire"}},policy());
    const reversed=Object.fromEntries(Object.entries(value).reverse());
    const second=parseConfiguredLeadCapture({...reversed,fields:{...value.fields,ownerContact:"Propriétaire"}},policy());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
  it("normalizes equivalent nonce spellings before their native UUID uniqueness boundary",()=>{
    const value=input();expect(parseConfiguredLeadCapture({...value,idempotencyKey:value.idempotencyKey.toUpperCase()},policy())).toEqual(parseConfiguredLeadCapture(value,policy()));
  });
  it.each(["organizationId","actorId","ownerId","personId","status","assignedRepresentativeId"])("rejects caller-selected %s instead of associating a private record",field=>{
    expect(()=>parseConfiguredLeadCapture({...input(),[field]:randomUUID()},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture({...input(),fields:{...input().fields,[field]:randomUUID()}},policy())).toThrow();
  });
  it("resolves the configured contact rule and required fields without treating zero as missing",()=>{
    const value=input();expect(()=>parseConfiguredLeadCapture(value,{...policy(),required_fields:["bedrooms"]})).not.toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,bedrooms:undefined}},{...policy(),required_fields:["bedrooms"]})).toThrow();
    expect(()=>parseConfiguredLeadCapture(value,{...policy(),contact_requirement:"PHONE_AND_EMAIL"})).toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,phone:"+212 600 000 000"}},{...policy(),contact_requirement:"PHONE_AND_EMAIL"})).not.toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,email:undefined}},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,location:undefined}},policy())).toThrow();
  });
  it.each(["propertyTypeKey","currentRentalStatusKey"] as const)("rejects unconfigured %s",field=>{
    const value=input();expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,[field]:"not_approved"}},policy())).toThrow();
  });
  it("rejects invented OTA entries, duplicates, disabled channels and cross-channel source reuse",()=>{
    const value=input();expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,currentOtaKeys:["not_approved"]}},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,currentOtaKeys:["configured_ota","configured_ota"]}},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,sourceKey:"unknown"},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture(value,{...policy(),sources:[{key:"assessment",label,channels:["WEBSITE"]}]})).toThrow();
    expect(()=>leadCapturePolicySchema.parse({...policy(),channels:["MANUAL"],sources:policy().sources})).toThrow();
  });
  it("records referral claims without trusting an existing person or accepting them through the website",()=>{
    const value={...input(),channel:"REFERRAL" as const};expect(()=>parseConfiguredLeadCapture(value,policy())).toThrow();
    expect(parseConfiguredLeadCapture({...value,fields:{...value.fields,referralContact:{name:"Référent",phone:"+212 600 000 001"}}},policy()).fields.referralContact?.name).toBe("Référent");
    expect(()=>parseConfiguredLeadCapture({...value,fields:{...value.fields,referralContact:{name:"Référent",personId:randomUUID()}}},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture({...input(),fields:{...value.fields,referralContact:{name:"Référent"}}},policy())).toThrow();
  });
  it("uses explicit configuration for names and referral contact requirements without inventing business defaults",()=>{
    const value={...input(),fields:{...input().fields,ownerContact:undefined}};
    expect(()=>parseConfiguredLeadCapture(value,policy())).not.toThrow();
    expect(()=>parseConfiguredLeadCapture(value,{...policy(),required_fields:["ownerContact"]})).toThrow();
    expect(()=>parseConfiguredLeadCapture({...value,channel:"REFERRAL"},{...policy(),referral_contact_required:false})).not.toThrow();
    expect(()=>leadCapturePolicySchema.parse({...policy(),referral_contact_required:undefined})).toThrow();
  });
  it("requires the exact approved website notice and cannot manufacture consent on internal captures",()=>{
    const value={...input(),channel:"WEBSITE" as const},ack={approvalReference:"approved-notice-v1",noticeSha256:"a".repeat(64),affirmed:true as const};
    expect(()=>parseConfiguredLeadCapture(value,policy())).toThrow();expect(parseConfiguredLeadCapture({...value,websiteAcknowledgement:ack},policy()).websiteAcknowledgement).toEqual(ack);
    for(const change of [{approvalReference:"retired-notice"},{noticeSha256:"b".repeat(64)},{affirmed:false}])
      expect(()=>parseConfiguredLeadCapture({...value,websiteAcknowledgement:{...ack,...change}},policy())).toThrow();
    expect(()=>parseConfiguredLeadCapture({...input(),websiteAcknowledgement:ack},policy())).toThrow();
    expect(()=>leadCapturePolicySchema.parse({...policy(),website_notice:null})).toThrow();
    expect(()=>leadCapturePolicySchema.parse({...policy(),processing_approval_reference:""})).toThrow();
  });
  it("rejects absent policies, missing EN/FR labels, duplicate sources and unbounded protocol fields",()=>{
    for(const value of [undefined,{}, {...policy(),sources:[...policy().sources,...policy().sources]},
      {...policy(),sources:[{key:"assessment",label:{en:"Only EN"},channels:["MANUAL"]}]}])expect(()=>leadCapturePolicySchema.parse(value)).toThrow();
    for(const fields of [{...input().fields,notes:"x".repeat(8001)},{...input().fields,ownerContact:"private\u0000value"},{...input().fields,bedrooms:0.5}])
      expect(()=>leadCaptureInputSchema.parse({...input(),fields})).toThrow();
  });
  it("bounds canonical UTF-8 bytes for internal callers as well as the public HTTP body",()=>{
    const value={...input(),fields:{...input().fields,notes:"م".repeat(8000),objectives:"م".repeat(8000),location:"م".repeat(1000)}};
    expect(leadCaptureInputSchema.safeParse(value).success).toBe(true);expect(()=>parseConfiguredLeadCapture(value,policy())).toThrow();
  });
});

describe("private lead payload encryption through the original platform AEAD",()=>{
  it("retains exact multilingual acquisition details while keeping PII absent from ciphertext",()=>{
    const value=parseConfiguredLeadCapture({...input(),fields:{...input().fields,ownerContact:"مالك خاص",notes:"Détails privés"}},policy()),identity=binding(value),cipher=encryptLeadPayload(value,identity,keys);
    expect(decryptLeadPayload(cipher,identity,keys)).toEqual(value);
    expect(cipher.includes(Buffer.from(value.fields.ownerContact!))).toBe(false);expect(cipher.includes(Buffer.from(value.fields.email!))).toBe(false);expect(cipher.includes(Buffer.from(value.fields.notes!))).toBe(false);
  });
  it.each(["organizationId","leadId","createdBy","policyId","idempotencyKey"] as const)("rejects ciphertext transplanted to another %s",field=>{
    const value=input(),identity=binding(value),cipher=encryptLeadPayload(value,identity,keys);
    expect(()=>decryptLeadPayload(cipher,{...identity,[field]:randomUUID()},keys)).toThrow();
  });
  it("authenticates policy version, channel, source and every ciphertext byte",()=>{
    const value=input(),identity=binding(value),cipher=encryptLeadPayload(value,identity,keys);
    for(const change of [{policyVersion:4},{channel:"WEBSITE" as const},{sourceKey:"other_source"}])expect(()=>decryptLeadPayload(cipher,{...identity,...change},keys)).toThrow();
    const tampered=Buffer.from(cipher);tampered[tampered.length-1]^=1;expect(()=>decryptLeadPayload(tampered,identity,keys)).toThrow();
  });
  it("reads retained versions after key rotation and fails closed when the retained key is missing",()=>{
    const value=input(),identity=binding(value),cipher=encryptLeadPayload(value,identity,keys),newKey="rotated:"+Buffer.alloc(32,81).toString("base64");
    expect(decryptLeadPayload(cipher,identity,{...keys,ENCRYPTION_KEYS:newKey+","+keys.ENCRYPTION_KEYS})).toEqual(value);
    expect(()=>decryptLeadPayload(cipher,identity,{...keys,ENCRYPTION_KEYS:newKey})).toThrow();
    const rotated=encryptLeadPayload(value,identity,{...keys,ENCRYPTION_KEYS:newKey+","+keys.ENCRYPTION_KEYS});
    expect(decryptLeadPayload(rotated,identity,{...keys,ENCRYPTION_KEYS:newKey})).toEqual(value);
  });
  it("requires explicit private-data keys even when identity development fallbacks are available",()=>{
    const value=input(),identity=binding(value),cipher=encryptLeadPayload(value,identity,keys);
    const unavailable:NodeJS.ProcessEnv[]=[{NODE_ENV:"test"}, {NODE_ENV:"development",AUTH_SECRET:"identity-only-secret"}, {NODE_ENV:"production",AUTH_SECRET:"identity-only-secret"}, {...keys,ENCRYPTION_KEYS:" , "}];
    for(const env of unavailable){
      expect(()=>encryptLeadPayload(value,identity,env)).toThrow(LeadConfigurationError);expect(()=>decryptLeadPayload(cipher,identity,env)).toThrow(LeadConfigurationError);
    }
  });
  it("cannot persist a command under a different channel, source or idempotency identity",()=>{
    const value=input(),identity=binding(value);
    for(const change of [{channel:"REFERRAL" as const},{sourceKey:"different"},{idempotencyKey:randomUUID()}])
      expect(()=>encryptLeadPayload(value,{...identity,...change},keys)).toThrow();
  });
  it("rejects empty, weak, ambiguous or malformed private-data key configuration without exposing it",()=>{
    const value=input(),identity=binding(value);
    for(const entry of ["original:","unversioned-password","original:weak-material",keys.ENCRYPTION_KEYS+","+keys.ENCRYPTION_KEYS,"original:"+Buffer.alloc(31).toString("base64")]){
      expect(()=>encryptLeadPayload(value,identity,{...keys,ENCRYPTION_KEYS:entry})).toThrow(LeadConfigurationError);
    }
  });
  it("retains legacy key entries used by other modules without permitting weak new lead encryption",()=>{
    const value=input(),identity=binding(value),legacy="identity-v0:retained-original-identity-key",withLegacy={...keys,ENCRYPTION_KEYS:keys.ENCRYPTION_KEYS+","+legacy};
    const cipher=encryptLeadPayload(value,identity,withLegacy);expect(decryptLeadPayload(cipher,identity,withLegacy)).toEqual(value);
    expect(decryptLeadPayload(cipher,identity,{...keys,ENCRYPTION_KEYS:legacy+","+keys.ENCRYPTION_KEYS})).toEqual(value);
    expect(()=>encryptLeadPayload(value,identity,{...keys,ENCRYPTION_KEYS:legacy+","+keys.ENCRYPTION_KEYS})).toThrow(LeadConfigurationError);
  });
  it("keeps the platform's canonical v1 interpretation for an existing unversioned 256-bit key",()=>{
    const value=input(),identity=binding(value),unversioned={...keys,ENCRYPTION_KEYS:Buffer.alloc(32,43).toString("base64")},cipher=encryptLeadPayload(value,identity,unversioned);
    expect(decryptLeadPayload(cipher,identity,unversioned)).toEqual(value);
  });
  it("keeps authenticated bindings stable across equivalent native UUID capitalization",()=>{
    const value=input(),identity=binding(value),upper={...identity,organizationId:identity.organizationId.toUpperCase(),leadId:identity.leadId.toUpperCase(),createdBy:identity.createdBy.toUpperCase(),policyId:identity.policyId.toUpperCase(),idempotencyKey:identity.idempotencyKey.toUpperCase()},cipher=encryptLeadPayload(value,upper,keys);
    expect(decryptLeadPayload(cipher,identity,keys)).toEqual(value);
  });
});
