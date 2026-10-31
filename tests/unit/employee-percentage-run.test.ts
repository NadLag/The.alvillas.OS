import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import {employeePercentageRunCreateInput,employeePercentageRunWindow,employeePercentageRunPolicySchema} from "@/modules/finance/domain/employee-percentage-run";
const policy={earning_date:"ACTUAL_POSTED_FINANCIAL_BASE",earning_unit:"PERSON_ASSIGNMENT_SELECTED_POSTINGS",timezone:"Africa/Casablanca",max_period_days:31};
const input=()=>({fromOn:"2026-10-01",toOn:"2026-10-31",currency:"MAD",purpose:"Original percentage earnings",reason:"Retain actual posted income and original contracts",idempotencyKey:randomUUID(),bases:[{postingId:randomUUID(),assignmentId:randomUUID()}]});
describe("configured original posted percentage run intent",()=>{
 it("requires the actual configured financial earning unit",()=>{expect(employeePercentageRunPolicySchema.parse(policy)).toEqual(policy);expect(()=>employeePercentageRunPolicySchema.parse({...policy,earning_date:"RECORDED_COMPLETION"})).toThrow();});
 it("converts the configured complete calendar using Morocco's IANA 2026c transition",()=>{const window=employeePercentageRunWindow("2026-10-01","2026-10-31",policy);expect(window.startsAt.toISOString()).toBe("2026-10-01T00:00:00.000Z");expect(window.endsAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");expect(window.policy).toEqual(policy);});
 it("enforces configured period bounds",()=>{expect(()=>employeePercentageRunWindow("2026-10-01","2026-11-01",policy)).toThrow();expect(()=>employeePercentageRunWindow("2026-10-02","2026-10-01",policy)).toThrow();});
 it("retains actual source identities and rejects entered amounts",()=>{const value=input();expect(employeePercentageRunCreateInput.parse(value)).toEqual(value);expect(()=>employeePercentageRunCreateInput.parse({...value,baseAmount:"1.00"})).toThrow();});
 it("rejects duplicate actual source and contract pairs",()=>{const value=input();expect(()=>employeePercentageRunCreateInput.parse({...value,bases:[value.bases[0],value.bases[0]]})).toThrow();});
 it("requires a real immutable source and original contract reference",()=>{const value=input();expect(()=>employeePercentageRunCreateInput.parse({...value,bases:[{postingId:value.bases[0].postingId,assignmentId:"entered"}]})).toThrow();});
});
