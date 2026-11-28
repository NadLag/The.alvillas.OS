import {expect,it} from "vitest";
import {presentAuditHistoryRow} from "@/modules/audit/application/audit-service";
import type {AuditActorContext} from "@/modules/audit/application/audit-access";
import type {AuditHistoryRow} from "@/modules/audit/infrastructure/audit-repository";
import {maskedValue} from "@/platform/authz/present";
const org="018f0a0b-0000-7000-9000-000000000001",id="018f0a0b-0000-7000-9000-000000000002";
const row:AuditHistoryRow={id,actorId:id,resourceId:id,resourceType:"inventory_location",action:"inventory.location.renamed",propertyScopeId:id,ipAddress:null,deviceId:null,before:{label:"Original private room"},after:{label:"Renamed private room"},reason:"Actual private physical stock location",requestId:id,occurredAt:new Date(0),createdAt:new Date(0)},source={type:"inventory_location",organizationId:org,id,propertyId:id,dataClass:"operational"as const};
function actor(keys:string[]):AuditActorContext{return{organizationId:org,actorId:id,personId:id,authContext:{organizationId:org,userAccountId:id,permissions:new Set(["audit_log:view","audit_log:export",...keys]),scopes:[{organizationId:org,scopeType:"organization"}]}};}
it("requires both original location catalog and independent property source access to disclose audit details",()=>{
 for(const keys of[[],["inventory_location:view"],["property:view"]])expect(presentAuditHistoryRow(actor(keys),row,"view",source).after).toBe(maskedValue);expect(presentAuditHistoryRow(actor(["inventory_location:view","property:view"]),row,"view",source).after).toEqual(row.after);expect(presentAuditHistoryRow(actor(["inventory_location:view","property:view"]),row).after).toBe(maskedValue);
});
it("requires independent exports and denies foreign or changed original property bindings",()=>{
 const keys=["inventory_location:view","inventory_location:export","property:view","property:export"];for(const missing of keys)expect(presentAuditHistoryRow(actor(keys.filter(key=>key!==missing)),row,"export",source).after).toBe(maskedValue);expect(presentAuditHistoryRow(actor(keys),row,"export",source).after).toEqual(row.after);expect(presentAuditHistoryRow(actor(keys),row,"view",{...source,propertyId:org}).after).toBe(maskedValue);
});
