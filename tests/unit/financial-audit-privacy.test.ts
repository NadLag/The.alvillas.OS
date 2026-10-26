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
  it.each(["financial_transaction","ledger_account"])("masks %s payload and reason for an audit-only reader",type=>{
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
});
