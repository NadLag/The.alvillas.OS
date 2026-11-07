import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentExpiryCommandSchema, documentExpiryRecoveredSchema } from "@/modules/documents/domain/document-expiry";
import { documentExpiryOccurrence, documentExpiryPolicySchema } from "@/modules/documents/domain/document-expiry-policy";

const labels={en:"Document expiry",fr:"Échéance du document",ar:"انتهاء صلاحية الوثيقة"};
const policy={source:"NATIVE_DOCUMENT_VERSIONS",calendar:"ORGANIZATION_PROFILE",principal:"CURRENT_CONFIGURATION_AUTHOR",version_selection:"CURRENT_EFFECTIVE_VERSION",type_keys:["permit","insurance","warranty","staff_contract"],change_admission:{window_seconds:3600,max_requests:100},send_at:"09:30",stages:[{key:"before",offset_days:-7,repeat_every_days:null,labels},{key:"expired",offset_days:0,repeat_every_days:3,labels}]};
const input={revisionId:randomUUID(),policyId:randomUUID(),dueOn:"2028-03-01",on:"2028-02-23",localTime:"09:30"};
describe("configured document expiry occurrences",()=>{
  it("waits for the explicit civil threshold and local send time",()=>{
    expect(documentExpiryOccurrence(policy,{...input,on:"2028-02-22"})).toBeNull();
    expect(documentExpiryOccurrence(policy,{...input,localTime:"09:29"})).toBeNull();
    expect(documentExpiryOccurrence(policy,input)).toMatchObject({stage:"before",on:"2028-02-23",labels});
  });
  it("catches up a missed tick without inventing a new occurrence or reinterpreting an expiry date",()=>{
    const first=documentExpiryOccurrence(policy,input),late=documentExpiryOccurrence(policy,{...input,on:"2028-02-27",localTime:"00:01"});
    expect(late).toEqual(first);
  });
  it("repeats only the configured active stage using exact civil days across leap day",()=>{
    expect(documentExpiryOccurrence(policy,{...input,on:"2028-03-01"})).toMatchObject({stage:"expired",on:"2028-03-01"});
    expect(documentExpiryOccurrence(policy,{...input,on:"2028-03-04"})).toMatchObject({stage:"expired",on:"2028-03-04"});
    expect(documentExpiryOccurrence(policy,{...input,on:"2028-03-05"})).toEqual(documentExpiryOccurrence(policy,{...input,on:"2028-03-04"}));
  });
  it("binds each occurrence to its actual immutable revision and configured rule",()=>{
    const original=documentExpiryOccurrence(policy,input)!;
    expect(documentExpiryOccurrence(policy,{...input,revisionId:randomUUID()})?.idempotencyKey).not.toBe(original.idempotencyKey);
    expect(documentExpiryOccurrence(policy,{...input,policyId:randomUUID()})?.idempotencyKey).not.toBe(original.idempotencyKey);
  });
  it("requires explicit business settings without supplying thresholds, kinds or schedules",()=>{
    for(const key of Object.keys(policy)){const missing:Record<string,unknown>={...policy};delete missing[key];expect(documentExpiryPolicySchema.safeParse(missing).success).toBe(false);}
    expect(documentExpiryPolicySchema.safeParse({...policy,type_keys:[]}).success).toBe(false);
    expect(documentExpiryPolicySchema.safeParse({...policy,type_keys:["permit","permit"]}).success).toBe(false);
  });
  it.each(["same-key","same-offset","descending","zero-repeat"])("rejects ambiguous configured %s stages",fault=>{
    const stages=policy.stages.map(item=>({...item}));if(fault==="same-key")stages[1].key=stages[0].key;if(fault==="same-offset")stages[1].offset_days=stages[0].offset_days;if(fault==="descending")stages.reverse();if(fault==="zero-repeat")stages[1].repeat_every_days=0;
    expect(documentExpiryPolicySchema.safeParse({...policy,stages}).success).toBe(false);
  });
  it("requires a native version, expected prior revision and durable actor command to clear an expiry",()=>{
    const command={versionId:randomUUID(),previousRevisionId:randomUUID(),expiresOn:null,idempotencyKey:randomUUID(),reviewFingerprint:"a".repeat(64),reason:"Retain an explicit cancellation rather than deleting expiry history"};
    expect(documentExpiryCommandSchema.parse(command)).toEqual(command);
    expect(documentExpiryCommandSchema.safeParse({...command,organizationId:randomUUID()}).success).toBe(false);
    expect(documentExpiryCommandSchema.safeParse({...command,sourceUrl:"https://foreign.example.test/private"}).success).toBe(false);
    expect(documentExpiryRecoveredSchema.safeParse({recorded:false,idempotencyKey:command.idempotencyKey,revision:null}).success).toBe(true);
    expect(documentExpiryRecoveredSchema.safeParse({recorded:true,idempotencyKey:command.idempotencyKey,revision:null}).success).toBe(false);
  });
});
