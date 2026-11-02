import { describe,expect,it } from "vitest";
import type { AuditActorContext } from "@/modules/audit/application/audit-access";
import type { AuditHistoryRow } from "@/modules/audit/infrastructure/audit-repository";
import { presentAuditHistoryRow } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";

const org="018f0a0b-0000-7000-9000-000000000001",id="018f0a0b-0000-7000-9000-000000000002",propertyId="018f0a0b-0000-7000-9000-000000000003";
const actor:AuditActorContext={organizationId:org,actorId:org,personId:org,authContext:{organizationId:org,userAccountId:org,
  permissions:new Set(["audit_log:view","audit_log:export"]),scopes:[{organizationId:org,scopeType:"organization"}]}};
const row=(resourceType:string):AuditHistoryRow=>({id,actorId:org,resourceId:id,resourceType,action:"finance.record.created",propertyScopeId:propertyId,
  before:null,after:{amount:"8000.00",currency:"MAD",name:"Dedicated financial source"},reason:"Dedicated confidential financial reason",requestId:id,occurredAt:new Date(0),createdAt:new Date(0),ipAddress:null,deviceId:null});

describe("financial transaction and account audit privacy",()=>{
  it("requires independent company receivable, financial and salary authority for assignment history",()=>{
    const entry={...row("receivable"),action:"finance.receivables.assigned",after:{assignmentId:id,partyId:propertyId,amount:"8000.00"}},
      permissions=[...actor.authContext.permissions,"receivable:view","receivable:export","financial_transaction:view","staff_compensation:view"],
      full={...actor,authContext:{...actor.authContext,permissions:new Set(permissions)}};
    for(const action of["view","export"] as const)expect(presentAuditHistoryRow(full,entry,action).after).toEqual(entry.after);
    for(const missing of["receivable:view","financial_transaction:view","staff_compensation:view"]){const denied={...full,authContext:{...full.authContext,permissions:new Set(permissions.filter(key=>key!==missing))}};
      expect(presentAuditHistoryRow(denied,entry,"view").after).toBe(maskedValue);expect(presentAuditHistoryRow(denied,entry,"view").reason).toBe(maskedValue);}
    const viewer={...full,authContext:{...full.authContext,permissions:new Set(permissions.filter(key=>key!=="receivable:export"))}};
    expect(presentAuditHistoryRow(viewer,entry,"view").after).toEqual(entry.after);expect(presentAuditHistoryRow(viewer,entry,"export").after).toBe(maskedValue);
  });
  it("cannot relabel a receivable audit or use a narrow financial scope to expose its original party",()=>{
    const entry={...row("task"),action:"finance.receivables.assignment_released",after:{assignmentId:id,partyId:propertyId}},permissions=new Set(["receivable:view","financial_transaction:view","staff_compensation:view"]),
      auditScope={organizationId:org,scopeType:"organization" as const},narrowScope={organizationId:org,scopeType:"property" as const,scopeId:propertyId},
      narrow={...actor,authContext:{...actor.authContext,permissions:new Set([...actor.authContext.permissions,...permissions]),assignments:[{scope:auditScope,permissions:actor.authContext.permissions},{scope:narrowScope,permissions}]}};
    for(const viewer of[actor,narrow]){const presented=presentAuditHistoryRow(viewer,entry,"view");expect(presented.after).toBe(maskedValue);expect(presented.reason).toBe(maskedValue);}
  });
  it.each(["financial_transaction","ledger_account","employee_compensation_claim"])("masks %s payload and reason for an audit-only reader",type=>{
    for(const action of ["view","export"] as const){const result=presentAuditHistoryRow(actor,row(type),action);
      expect(result.after).toBe(maskedValue);expect(result.reason).toBe(maskedValue);expect(JSON.stringify(result)).not.toContain("8000.00");}
  });
  it("requires the actual financial subject, current scope, amount and independent export permission",()=>{
    const scope={organizationId:org,scopeType:"property" as const,scopeId:propertyId},permissions=new Set(["audit_log:view","audit_log:export","financial_transaction:view"]);
    const auditScope={organizationId:org,scopeType:"organization" as const};
    const viewer={...actor,authContext:{...actor.authContext,permissions,scopes:[auditScope,scope],assignments:[{scope:auditScope,permissions:actor.authContext.permissions},
      {scope,permissions:new Set(["financial_transaction:view"]),conditions:{maxAmount:"9000"}}]}},source={type:"financial_transaction",organizationId:org,id,financialRecordId:id,propertyId,amount:"8000",dataClass:"financial" as const};
    expect(presentAuditHistoryRow(viewer,row("financial_transaction"),"view",source).after).toEqual(row("financial_transaction").after);
    expect(presentAuditHistoryRow(viewer,row("financial_transaction"),"export",source).after).toBe(maskedValue);
    for(const subject of [undefined,{...source,amount:"9000.01"},{...source,propertyId:id},{...source,id:org},{...source,organizationId:id}])
      expect(presentAuditHistoryRow(viewer,row("financial_transaction"),"view",subject).after).toBe(maskedValue);
  });
  it("keeps employee journal audits private without the original root, salary and full financial source",()=>{
    const base={...actor,authContext:{...actor.authContext,permissions:new Set([...actor.authContext.permissions,"financial_transaction:view","financial_transaction:export"]) }},
      root={type:"employee_payable",organizationId:org,id:org,amount:"8000.00",dataClass:"financial" as const},salary={type:"staff_compensation",organizationId:org,id:propertyId,amount:"8000.00",dataClass:"financial" as const},financial={type:"financial_transaction",organizationId:org,id,amount:"8000.00",dataClass:"financial" as const},
      source={...financial,compensationRoot:root,salarySources:[salary],financialSources:[financial]},full={...base,authContext:{...base.authContext,permissions:new Set([...base.authContext.permissions,"employee_payable:view","employee_payable:export","staff_compensation:view"])}};
    for(const action of["view","export"] as const){expect(presentAuditHistoryRow(base,row("financial_transaction"),action,source).after).toBe(maskedValue);expect(presentAuditHistoryRow(full,row("financial_transaction"),action,source).after).toEqual(row("financial_transaction").after);
      for(const changed of[{...source,salarySources:[]},{...source,financialSources:[]},{...source,compensationRoot:undefined},{...source,salarySources:[{...salary,organizationId:id}]}])expect(presentAuditHistoryRow(full,row("financial_transaction"),action,changed).after).toBe(maskedValue);}
  });
});
