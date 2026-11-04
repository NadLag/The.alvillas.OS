import {describe,expect,it} from "vitest";
import {guestDepositPolicyKey} from "@/platform/config/guest-deposit-policy";
import {financialRuleAccess,financialRuleKeysIn} from "@/platform/config/financial-rule-authority";
import type {AuthContext} from "@/platform/authz/authorize";
const organizationId="018f0a0b-0000-7000-9000-000000000001",userAccountId="018f0a0b-0000-7000-9000-000000000002";
const actor=(permissions:string[]):AuthContext=>({organizationId,userAccountId,permissions:new Set(permissions),scopes:[{organizationId,scopeType:"organization"}]});
describe("independent guest deposit policy authority",()=>{
 it("requires financial source view even when configuration or operational access is available",()=>{for(const permissions of[["config_rule:view"],["reservation:view","guest:view"],[]])expect(financialRuleAccess(actor(permissions),"view",new Date(),guestDepositPolicyKey)).toBe(false);expect(financialRuleAccess(actor(["financial_transaction:view"]),"view",new Date(),guestDepositPolicyKey)).toBe(true);});
 it("requires the independent original financial export grant",()=>{expect(financialRuleAccess(actor(["financial_transaction:view","config_rule:export"]),"export",new Date(),guestDepositPolicyKey)).toBe(false);expect(financialRuleAccess(actor(["financial_transaction:view","financial_transaction:export"]),"export",new Date(),guestDepositPolicyKey)).toBe(true);});
 it("does not assemble complete policy authority from a narrow property or amount cap",()=>{const ctx=actor(["financial_transaction:view"]);ctx.scopes=[{organizationId,scopeType:"property",scopeId:userAccountId}];expect(financialRuleAccess(ctx,"view",new Date(),guestDepositPolicyKey)).toBe(false);ctx.scopes=[{organizationId,scopeType:"organization"}];ctx.assignments=[{permissions:ctx.permissions,scope:ctx.scopes[0],conditions:{maxAmount:"100"}}];expect(financialRuleAccess(ctx,"view",new Date(),guestDepositPolicyKey)).toBe(false);});
 it("detects original policy keys and embedded source snapshots for shared audit and template privacy",()=>{for(const value of[{key:guestDepositPolicyKey},{nested:{source:"ACTUAL_GUEST_RECEIPT"}},{[guestDepositPolicyKey]:{}}])expect(financialRuleKeysIn(value)).toContain(guestDepositPolicyKey);});
});
