import {describe,expect,it} from "vitest";
import {financialRuleSourceChecks,protectedFinancialRuleKey} from "@/platform/config/financial-rule-authority";

describe("legacy and current compensation configuration require the same financial sources",()=>{
 it.each(["staff.compensation","staff.compensation_monthly_earnings","staff.compensation_percentage_runs"])("keeps %s independently protected from operational config grants",key=>{expect(protectedFinancialRuleKey(key)).toBe(true);const checks=financialRuleSourceChecks("actual-organization",key,"export");expect(checks).toHaveLength(6);expect(new Set(checks.map(check=>check.resource.type))).toEqual(new Set(["staff_compensation","employee_payable","financial_transaction"]));expect(checks.every(check=>check.organizationOnly&&check.resource.dataClass==="financial")).toBe(true);expect(checks.filter(check=>check.action==="export")).toHaveLength(3);});
});
