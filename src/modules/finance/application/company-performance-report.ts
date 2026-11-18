import { propertyFinanceFinancialSources } from "@/platform/authz/property-finance-resource";
import type { FinanceActorContext } from "./finance-access";
import { companyReportTotals, type CompanyPostingTotal, type PortfolioNights } from "../domain/performance-report";
import { readOrganizationPerformance, type OrganizationReportPeriod, type OrganizationReportSource,
  type PerformanceExport, type PerformanceReportDeps } from "./organization-performance-report";

type CompanySources = { postings: CompanyPostingTotal[]; portfolio: PortfolioNights[] };
type CompanyTotals = ReturnType<typeof companyReportTotals>;
export type CompanyPerformanceReport = CompanyTotals & OrganizationReportPeriod;

const source: OrganizationReportSource<CompanySources, CompanyTotals> = {
  auditResource: "company_report",
  operationalSources: ["property", "reservation"],
  financialSources: propertyFinanceFinancialSources,
  async capture(repository, query) {
    const [postings, portfolio] = await Promise.all([
      repository.companyPostings(query), repository.portfolioNights(query.fromOn, query.toOn)
    ]);
    return { postings, portfolio };
  },
  summarize: (currency, originals) => companyReportTotals(currency, originals.postings, originals.portfolio)
};

export function getCompanyPerformanceReport(actor: FinanceActorContext, raw: unknown, deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, raw, source, deps);
}
export function exportCompanyPerformanceReport(actor: FinanceActorContext, raw: unknown, output: PerformanceExport<CompanyPerformanceReport>,
  deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, raw, source, deps, output);
}
