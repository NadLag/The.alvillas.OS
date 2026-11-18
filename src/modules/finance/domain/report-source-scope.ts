import { propertyFinanceFinancialSources } from "@/platform/authz/property-finance-resource";

export const inventoryReportSources = {
  operationalSources: ["inventory_item", "inventory_location", "inventory_movement", "property", "reservation"],
  financialSources: ["financial_transaction", "expense", "supplier_invoice"]
} as const;
export const kpiReportSources = {
  operationalSources: [...inventoryReportSources.operationalSources, "task", "issue", "owner", "team_member", "role", "supplier"],
  financialSources: [...inventoryReportSources.financialSources, "company_ledger", "service_allocation", "wallet", "cash_collection"]
} as const;
export const teamReportSources = {
  operationalSources: ["team_member", "task"],
  financialSources: ["financial_transaction", "employee_payable", "staff_compensation", "wallet"]
} as const;
export const companyReportSources = {
  operationalSources: ["property", "reservation"],
  financialSources: propertyFinanceFinancialSources
} as const;
