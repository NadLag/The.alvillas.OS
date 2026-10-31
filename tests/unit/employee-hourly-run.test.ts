import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { employeeHourlyRunSourceInput,employeeHourlyRunCreateInput,employeeHourlyRunPolicySchema } from "@/modules/finance/domain/employee-hourly-run";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";

const policy={earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31,earning_unit:"VALIDATED_COMPLETED_WORK_SOURCE",rounding:"HALF_UP_AT_EARNING_TOTAL",overlap_between_sources:"REJECT_PER_PERSON"};
const job=()=>({taskId:randomUUID(),assignmentId:randomUUID(),evidenceId:randomUUID(),decisionId:randomUUID(),confirmedAssignment:true});
const input=()=>({fromOn:"2026-10-01",toOn:"2026-10-31",currency:"MAD",jobs:[job()]});
describe("actual hourly earning request and explicit policy",()=>{
 it.each(["REJECT_PER_PERSON","ALLOW_PER_VALIDATED_SOURCE"])("retains the explicit configured overlap choice %s",overlap=>{expect(parseConfigRuleValue("staff.compensation_hourly_runs",{...policy,overlap_between_sources:overlap})).toEqual({...policy,overlap_between_sources:overlap});});
 it.each(Object.keys(policy))("requires explicit policy field %s without a default",field=>{expect(()=>employeeHourlyRunPolicySchema.parse(Object.fromEntries(Object.entries(policy).filter(([key])=>key!==field)))).toThrow();});
 it("rejects planned-duration or ambiguous earning units",()=>{expect(()=>employeeHourlyRunPolicySchema.parse({...policy,earning_unit:"PLANNED_TASK_HOURS"})).toThrow();expect(()=>employeeHourlyRunPolicySchema.parse({...policy,rounding:"PER_INTERVAL"})).toThrow();});
 it("binds the original actual task, assignment, evidence and validation",()=>{const value=input();expect(employeeHourlyRunSourceInput.parse(value)).toEqual(value);expect(()=>employeeHourlyRunSourceInput.parse({...value,jobs:[{...value.jobs[0],decisionId:undefined}]})).toThrow();expect(()=>employeeHourlyRunSourceInput.parse({...value,jobs:[{...value.jobs[0],confirmedAssignment:false}]})).toThrow();});
 it("retains source refinement when adding purpose and the original nonce",()=>{const value={...input(),purpose:"Actual validated hourly earnings",reason:"Prepare the original completed-work source earnings",idempotencyKey:randomUUID()};expect(employeeHourlyRunCreateInput.parse(value)).toEqual(value);expect(()=>employeeHourlyRunCreateInput.parse({...value,jobs:[...value.jobs,...value.jobs]})).toThrow();expect(()=>employeeHourlyRunCreateInput.parse({...value,fromOn:"2026-11-01"})).toThrow();});
});
