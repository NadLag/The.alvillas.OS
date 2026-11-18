import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import type { AuthContext } from "@/platform/authz/authorize";
import { Money } from "@/platform/money/money";
import { companyLedgerTotals } from "../domain/company-ledger";
import { companyReportTotals } from "../domain/performance-report";
import type { PerformanceReportRepository } from "../infrastructure/performance-report-repository";
import type { FinanceActorContext } from "./finance-access";
import { readOrganizationPerformance, type OrganizationReportSource, type PerformanceReportDeps } from "./organization-performance-report";

const financialSources = ["financial_transaction", "company_ledger", "expense", "owner_statement", "cash_collection"] as const;
export function canViewCommandFinance(context: AuthContext, when = new Date()) {
  return ["report", ...financialSources].every(type => authorizeOrganizationSource(context, "view",
    { type, organizationId: context.organizationId, dataClass: "financial" }, when));
}

type Source = Awaited<ReturnType<PerformanceReportRepository["commandFinance"]>>;
function summarize(currency: string, source: Source) {
  const company = companyReportTotals(currency, source.postings, []);
  return { revenue: company.revenue, expenses: company.amounts.operatingCosts, cash: company.cashPosition,
    ownerPayable: Money.of(source.payable, currency),
    companyBalance: Money.of(companyLedgerTotals(source.accounts, currency).closingBalance, currency) };
}
const descriptor: OrganizationReportSource<Source, ReturnType<typeof summarize>> = {
  auditResource: "command_finance", operationalSources: [], financialSources,
  capture: (repository, query) => repository.commandFinance(query), summarize
};

export function getCommandFinance(actor: FinanceActorContext, raw: unknown, deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, raw, descriptor, deps);
}
