import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {onboardingActivationJobReferenceSchema,onboardingActivationContinuationPayloadSchema,onboardingActivationContinuationKey,onboardingActivationContinuationDue} from "@/modules/onboarding/domain/onboarding-activation-job";
import {onboardingActivationEffects} from "@/modules/onboarding/domain/onboarding-activation-policy";
import {OnboardingConfigurationError} from "@/modules/onboarding/domain/onboarding-wizard";

const policy={modes:["BACKGROUND"],effects:[...onboardingActivationEffects],retry:{max_attempts:3,backoff_seconds:7}},now=new Date("2026-11-13T09:30:00.000Z");
describe("reference-only native activation continuations",()=>{
 it("binds stable continuation identity to the actual source UUID",()=>{const source=randomUUID();expect(onboardingActivationContinuationKey(source.toUpperCase())).toBe("onboarding.activation.continue:"+source);expect(()=>onboardingActivationContinuationKey("invented-source")).toThrow();});
 it("accepts only organization and outbox references, never actor or completion claims",()=>{const input={organizationId:randomUUID(),outboxEventId:randomUUID()};expect(onboardingActivationJobReferenceSchema.parse(input)).toEqual(input);expect(onboardingActivationJobReferenceSchema.safeParse({...input,actorId:randomUUID(),ready:true}).success).toBe(false);});
 it("requires immutable run, parent, head and actual UTC due references",()=>{const value={activationId:randomUUID(),sourceOutboxEventId:randomUUID(),activationHeadId:randomUUID(),notBefore:now.toISOString()};expect(onboardingActivationContinuationPayloadSchema.parse(value)).toEqual(value);expect(onboardingActivationContinuationPayloadSchema.safeParse({...value,completed:["DOCUMENTS"]}).success).toBe(false);expect(onboardingActivationContinuationPayloadSchema.safeParse({...value,notBefore:"later"}).success).toBe(false);});
 it.each(["REQUESTED","SUCCEEDED"])("does not invent a business delay after %s",type=>{expect(onboardingActivationContinuationDue(policy,{type,nextAttemptAt:null},now)).toBeNull();});
 it("uses the captured backoff for actual pending work",()=>{expect(onboardingActivationContinuationDue(policy,{type:"STARTED",nextAttemptAt:null},now)?.toISOString()).toBe("2026-11-13T09:30:07.000Z");});
 it("retains an actual later rate-limit reset instead of polling before it",()=>{expect(onboardingActivationContinuationDue(policy,{type:"STARTED",nextAttemptAt:null},now,"2026-11-13T09:31:00.000Z")?.toISOString()).toBe("2026-11-13T09:31:00.000Z");});
 it("uses the exact recorded retry time while it remains future",()=>{expect(onboardingActivationContinuationDue(policy,{type:"RETRY_SCHEDULED",nextAttemptAt:new Date("2026-11-13T09:30:04.000Z")},now)?.toISOString()).toBe("2026-11-13T09:30:04.000Z");});
 it("admits an already due actual retry without another artificial delay",()=>{expect(onboardingActivationContinuationDue(policy,{type:"RETRY_SCHEDULED",nextAttemptAt:new Date("2026-11-13T09:29:59.000Z")},now)).toBeNull();});
 it.each(["ACTIVATED","FAILED","BLOCKED","UNKNOWN"])("keeps %s closed to automatic continuation",type=>{expect(()=>onboardingActivationContinuationDue(policy,{type,nextAttemptAt:null},now)).toThrow(OnboardingConfigurationError);});
 it("rejects a retry without an actual recorded due time",()=>{expect(()=>onboardingActivationContinuationDue(policy,{type:"RETRY_SCHEDULED",nextAttemptAt:null},now)).toThrow(OnboardingConfigurationError);});
 it("requires a valid clock and approved retry policy without defaults",()=>{expect(()=>onboardingActivationContinuationDue(policy,{type:"STARTED",nextAttemptAt:null},new Date(NaN))).toThrow(OnboardingConfigurationError);expect(()=>onboardingActivationContinuationDue({...policy,retry:undefined},{type:"STARTED",nextAttemptAt:null},now)).toThrow();});
});
