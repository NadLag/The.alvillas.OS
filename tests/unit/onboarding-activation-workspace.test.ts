import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {onboardingActivationWorkspaceInputSchema,onboardingActivationWorkspaceSchema} from "@/modules/onboarding/domain/onboarding-activation-workspace";

const propertyId=randomUUID(),metadata=()=>({sessionId:randomUUID(),property:{id:propertyId,name:"Actual approved villa"},review:{revisionId:randomUUID(),propertyId},canApprove:true,run:null});
describe("private native activation navigation contract",()=>{
 it("accepts actual scoped review metadata without accepting a completion claim",()=>{const value=metadata();expect(onboardingActivationWorkspaceSchema.parse(value)).toEqual(value);expect(onboardingActivationWorkspaceSchema.safeParse({...value,ready:true}).success).toBe(false);});
 it("requires the original native property for a selectable review",()=>{expect(onboardingActivationWorkspaceSchema.safeParse({...metadata(),property:{id:randomUUID(),name:"Another actual property"}}).success).toBe(false);});
 it("cannot grant approval without an actual native review",()=>{expect(onboardingActivationWorkspaceSchema.safeParse({...metadata(),review:null}).success).toBe(false);});
 it("cannot advertise another admission for the same already recorded review",()=>{const value=metadata();expect(onboardingActivationWorkspaceSchema.safeParse({...value,run:{runId:randomUUID(),reviewRevisionId:value.review.revisionId,idempotencyKey:randomUUID()}}).success).toBe(false);});
 it("retains an actual native tracking nonce when further approval is closed",()=>{const value={...metadata(),canApprove:false,review:null,run:{runId:randomUUID(),reviewRevisionId:randomUUID(),idempotencyKey:randomUUID()}};expect(onboardingActivationWorkspaceSchema.parse(value)).toEqual(value);});
 it("accepts only a tenant-resolved session reference and rejects client grants, property selection and readiness",()=>{const sessionId=randomUUID();expect(onboardingActivationWorkspaceInputSchema.parse({sessionId})).toEqual({sessionId});for(const extra of[{canApprove:true},{propertyId},{ready:true},{organizationId:randomUUID()}])expect(onboardingActivationWorkspaceInputSchema.safeParse({sessionId,...extra}).success).toBe(false);});
});
