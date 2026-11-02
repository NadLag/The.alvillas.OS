import {describe,expect,it} from "vitest";
import type {AuthContext,Resource} from "@/platform/authz/authorize";
import {canReadReceivableReminder} from "@/modules/finance/domain/receivable-reminder-notification";

const org="00000000-0000-4000-8000-000000000001",actor="00000000-0000-4000-8000-000000000002",keys=["receivable:view","financial_transaction:view","staff_compensation:view"],scope={organizationId:org,resourceType:"organization"},now=new Date("2026-11-02T12:00:00Z"),target:Resource={type:"receivable",organizationId:org,id:"00000000-0000-4000-8000-000000000003",dataClass:"financial"};
function context(permissions=keys):AuthContext{return{organizationId:org,userAccountId:actor,permissions:new Set(permissions),scopes:[scope],assignments:[{scope,permissions:new Set(permissions)}]};}
describe("independently protected receivable reminder destinations",()=>{
 it("requires complete organization financial authority even when routing selected the recipient",()=>expect(canReadReceivableReminder(context(),target,now)).toBe(true));
 it.each(keys)("requires the independent %s permission",key=>expect(canReadReceivableReminder(context(keys.filter(value=>value!==key)),target,now)).toBe(false));
 it("permits independent grants without treating a role name as data access",()=>{const ctx=context();ctx.assignments=keys.map(key=>({scope,permissions:new Set([key])}));expect(canReadReceivableReminder(ctx,target,now)).toBe(true);});
 it.each(["task","property","identity"])("never accepts an operational %s target",type=>expect(canReadReceivableReminder(context(),{...target,type},now)).toBe(false));
 it("rejects tenant substitution and operational data classification",()=>{expect(canReadReceivableReminder(context(),{...target,organizationId:"00000000-0000-4000-8000-000000000004"},now)).toBe(false);expect(canReadReceivableReminder(context(),{...target,dataClass:"operational"},now)).toBe(false);});
 it("rejects a narrower original-record or property grant despite complete flattened keys",()=>{for(const scoped of[{organizationId:org,resourceType:"financial_record",resourceId:target.id},{organizationId:org,resourceType:"property",resourceId:target.id}]){const ctx=context();ctx.assignments=[{scope:scoped,permissions:new Set(keys)}];expect(canReadReceivableReminder(ctx,target,now)).toBe(false);}});
 it("rejects amount-conditional grants and expired organization authority",()=>{const ctx=context();ctx.assignments=[{scope,permissions:new Set(keys),conditions:{maxAmount:"1000.00"}}];expect(canReadReceivableReminder(ctx,target,now)).toBe(false);ctx.assignments=[{scope,permissions:new Set(keys),validTo:new Date("2026-11-02T11:59:59Z")}];expect(canReadReceivableReminder(ctx,target,now)).toBe(false);});
});
