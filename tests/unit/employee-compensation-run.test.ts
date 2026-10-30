import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { employeeCompensationRunCreateSchema,employeeCompensationRunWindow,EmployeeCompensationRunPolicyError } from "@/modules/finance/domain/employee-compensation-run";
import { employeeCompensationRunFacts } from "@/platform/authz/employee-compensation-resource";
import { authorize,type AuthContext } from "@/platform/authz/authorize";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import type { AuditHistoryRow } from "@/modules/audit/infrastructure/audit-repository";
import { maskedValue } from "@/platform/authz/present";

const organizationId=randomUUID(),personId=randomUUID(),propertyId=randomUUID(),id=randomUUID(),at=new Date("2026-10-30T12:00:00Z");
const policy={earning_date:"RECORDED_COMPLETION",timezone:"America/New_York",max_period_days:2};
const source=(jobs=2,amount="500.25")=>({id,currency:"MAD",createdAt:at,lines:Array.from({length:jobs},()=>({
  personId,propertyId,taskId:randomUUID(),recordedCompletionAt:at,currency:"MAD",rate:amount,amount,property:{cityId:null,regionId:null}}))});
const context=(salaryLimit?:string):AuthContext=>({organizationId,permissions:new Set(["audit_log:view","audit_log:export","employee_payable:view","employee_payable:export","staff_compensation:view"]),scopes:[],
  assignments:[{permissions:new Set(["audit_log:view","audit_log:export","employee_payable:view","employee_payable:export"]),scope:{organizationId,scopeType:"organization"}},
    {permissions:new Set(["staff_compensation:view"]),scope:{organizationId,scopeType:"organization"},conditions:salaryLimit?{maxAmount:salaryLimit}:undefined}]});
const audit:AuditHistoryRow={id:randomUUID(),actorId:personId,action:"finance.employee_compensation_run.created",resourceType:"employee_compensation_run",resourceId:id,
  ipAddress:null,deviceId:null,propertyScopeId:null,before:null,after:{runId:id,total:{amount:"1000.50",currency:"MAD"}},reason:"Private compensation agreement",
  requestId:randomUUID(),occurredAt:at,createdAt:at};

describe("immutable completed-work compensation run boundaries",()=>{
  it("groups recorded completions by configured calendar dates across a DST fallback",()=>{
    const result=employeeCompensationRunWindow("2026-10-31","2026-11-01",policy);
    expect(result.days).toBe(2);expect(result.startsAt.toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(result.endsAt.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
  it.each([["2026-11-01","2026-10-31"],["2026-10-30","2026-11-01"]])("rejects reversed or policy-exceeding periods %s to %s",(from,to)=>{
    expect(()=>employeeCompensationRunWindow(from,to,policy)).toThrow(EmployeeCompensationRunPolicyError);
  });
  it.each([false,undefined,"true",1])("requires actual assignment consent, including %s",confirmedAssignment=>{
    expect(employeeCompensationRunCreateSchema.safeParse({fromOn:"2026-10-30",toOn:"2026-10-30",currency:"MAD",purpose:"Actual work",reason:"Actual completed work",idempotencyKey:randomUUID(),
      jobs:[{taskId:randomUUID(),assignmentId:randomUUID(),confirmedAssignment}]}).success).toBe(false);
  });
  it("rejects duplicated actual work even when UUID casing differs",()=>{
    const taskId=randomUUID();expect(employeeCompensationRunCreateSchema.safeParse({fromOn:"2026-10-30",toOn:"2026-10-30",currency:"MAD",purpose:"Actual work",reason:"Actual completed work",idempotencyKey:randomUUID(),
      jobs:[{taskId,assignmentId:randomUUID(),confirmedAssignment:true},{taskId:taskId.toUpperCase(),assignmentId:randomUUID(),confirmedAssignment:true}]}).success).toBe(false);
  });
  it("retains the exact 500-source total above individual storage precision",()=>{
    const facts=employeeCompensationRunFacts(organizationId,source(500,"9999999999999999.99"));
    expect(facts.total.toJSON()).toEqual({amount:"4999999999999999995.00",currency:"MAD"});
    expect(facts.salarySources.every(resource=>resource.amount==="9999999999999999.99"||resource.amount==="4999999999999999995.00")).toBe(true);
  });
  it("enforces the beneficiary's complete amount when each individual job fits a salary cap",()=>{
    const facts=employeeCompensationRunFacts(organizationId,source()),auth=context("750.00");
    expect(authorize(auth,"view",facts.salarySources[0],at)).toBe(true);
    expect(facts.salarySources.every(resource=>authorize(auth,"view",resource,at))).toBe(false);
  });
  it.each(["view","export"] as const)("masks run audit amounts and reasons without the actual source on %s",action=>{
    const result=presentAuditHistoryRow({organizationId,actorId:personId,personId,authContext:context()},audit,action);
    expect(result.after).toBe(maskedValue);expect(result.reason).toBe(maskedValue);
  });
  it.each(["view","export"] as const)("retains actual salary caps for run audit %s",action=>{
    const facts=employeeCompensationRunFacts(organizationId,source()),resource={...facts.resource,salarySources:facts.salarySources};
    const denied=presentAuditHistoryRow({organizationId,actorId:personId,personId,authContext:context("750.00")},audit,action,resource);
    expect(denied.after).toBe(maskedValue);expect(denied.reason).toBe(maskedValue);
    const allowed=presentAuditHistoryRow({organizationId,actorId:personId,personId,authContext:context("1000.50")},audit,action,resource);
    expect(allowed.after).toEqual(audit.after);expect(allowed.reason).toBe(audit.reason);
  });
  it("rejects a borrowed run identity when presenting actual financial audit sources",()=>{
    const facts=employeeCompensationRunFacts(organizationId,source());
    expect(presentAuditHistoryRow({organizationId,actorId:personId,personId,authContext:context()},audit,"view",{...facts.resource,id:randomUUID(),salarySources:facts.salarySources}).after).toBe(maskedValue);
  });
});
