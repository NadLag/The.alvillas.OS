import {expect,it} from "vitest";
import {presentAuditHistoryRow} from "@/modules/audit/application/audit-service";
import type {AuditActorContext} from "@/modules/audit/application/audit-access";
import type {AuditHistoryRow} from "@/modules/audit/infrastructure/audit-repository";
import {maskedValue} from "@/platform/authz/present";
const id="018f0a0b-0000-7000-9000-000000000001";
function actor(permissions:string[]):AuditActorContext{return{organizationId:id,actorId:id,personId:id,authContext:{organizationId:id,userAccountId:id,permissions:new Set(["audit_log:view","audit_log:export",...permissions]),scopes:[{organizationId:id,scopeType:"organization"}]}};}
const original:AuditHistoryRow={id,actorId:id,resourceId:id,resourceType:"inventory_item",action:"inventory.item.renamed",propertyScopeId:null,ipAddress:null,deviceId:null,before:{name:"Private original label"},after:{name:"Private renamed label"},reason:"Private original metadata explanation",requestId:id,occurredAt:new Date(0),createdAt:new Date(0)};
it("requires original inventory catalog authority for private item audit details",()=>{
 for(const resourceType of["inventory_item","inventory_item_command"]){const row={...original,resourceType};for(const permissions of[[],["inventory_item:export"]]){const shown=presentAuditHistoryRow(actor(permissions),row);expect(shown.before).toBe(maskedValue);expect(shown.after).toBe(maskedValue);expect(shown.reason).toBe(maskedValue);}expect(presentAuditHistoryRow(actor(["inventory_item:view"]),row).after).toEqual(row.after);}
});
it("requires independent inventory export authority to disclose original metadata in audit exports",()=>{
 expect(presentAuditHistoryRow(actor(["inventory_item:view"]),original,"export").after).toBe(maskedValue);expect(presentAuditHistoryRow(actor(["inventory_item:view","inventory_item:export"]),original,"export").after).toEqual(original.after);
});
it("does not turn a property-only or conditional inventory permission into catalog audit authority",()=>{
 const scoped=actor([]);scoped.authContext.assignments=[{permissions:new Set(["audit_log:view"]),scope:{organizationId:id,scopeType:"organization"}},{permissions:new Set(["inventory_item:view"]),scope:{organizationId:id,scopeType:"property",scopeId:id}}];expect(presentAuditHistoryRow(scoped,original).after).toBe(maskedValue);
});
