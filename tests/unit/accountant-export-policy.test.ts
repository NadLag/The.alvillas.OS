import { describe, expect, it } from "vitest";
import { accountantExportPolicyKey, accountantExportPolicySchema } from "@/modules/finance/domain/accountant-export-policy";
import { accountantReportKinds, accountantExportFormats } from "@/modules/finance/domain/accountant-export";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";

const policy = { source: "ORIGINAL_POSTED_FINANCIAL_SOURCES", reports: [...accountantReportKinds], formats: [...accountantExportFormats],
  classifications: { income: { buckets: ["EXPLICIT_FIXTURE_REVENUE"], account_types: ["ALVILLAS_OWN"], sides: ["CREDIT"] }, expenses: { buckets: ["EXPLICIT_FIXTURE_COST"], account_types: ["ALVILLAS_OWN"], sides: ["DEBIT"] } },
  capacity: { CSV: 100, EXCEL: 100, PDF: 20 }, rate_limit: { requests: 3, window_seconds: 60 } };
describe("configured accountant exports without assumed accounting treatment", () => {
  it("uses the original configuration registry with explicit classifications, formats, capacities and durable admission limits", () => {
    expect(parseConfigRuleValue(accountantExportPolicyKey, policy)).toEqual(policy);
  });
  it("does not infer income or expense classification from account names, signs or another report", () => {
    for (const classifications of [{}, { income: policy.classifications.income }, { expenses: policy.classifications.expenses }])
      expect(accountantExportPolicySchema.safeParse({ ...policy, classifications }).success).toBe(false);
    expect(accountantExportPolicySchema.safeParse({ ...policy, reports: ["TRANSACTIONS"], classifications: {} }).success).toBe(true);
  });
  it("rejects duplicate definitions, missing or zero capacities, noninteger admission and injected country treatment", () => {
    for (const value of [{ ...policy, reports: ["INCOME", "INCOME"] }, { ...policy, formats: ["CSV", "CSV"] }, { ...policy, capacity: { ...policy.capacity, PDF: 0 } },
      { ...policy, rate_limit: { requests: 1.5, window_seconds: 60 } }, { ...policy, tax_rate: 20 },
      { ...policy, classifications: { ...policy.classifications, income: { buckets: ["same", "same"], sides: ["CREDIT"] } } }])
      expect(accountantExportPolicySchema.safeParse(value).success).toBe(false);
  });
  it("protects configuration history through the original independent financial roots", () => {
    const checks = financialRuleSourceChecks("fixture-org", accountantExportPolicyKey, "export");
    for (const type of ["financial_transaction", "staff_compensation", "owner_statement", "company_ledger", "bank_statement", "company_expense"])
      expect(checks.filter(check => check.resource.type === type).map(check => ({ action: check.action, organizationOnly: check.organizationOnly })))
        .toEqual([{ action: "view", organizationOnly: true }, { action: "export", organizationOnly: true }]);
  });
  it("does not classify physical custody as income or expense ownership", () => {
    expect(accountantExportPolicySchema.safeParse({ ...policy, classifications: { ...policy.classifications,
      income: { ...policy.classifications.income, account_types: ["ASSET_LOCATION"] } } }).success).toBe(false);
  });
});
