import type { FinanceActorContext } from "./finance-access";
import { teamReportSources } from "../domain/report-source-scope";
import type { TeamPerformanceSource } from "../domain/performance-report";
import { readOrganizationPerformance, type OrganizationReportPeriod, type OrganizationReportSource,
  type PerformanceExport, type PerformanceReportDeps } from "./organization-performance-report";

type TeamResults = { people: TeamPerformanceSource[] };
export type TeamPerformanceReport = TeamResults & OrganizationReportPeriod;
const source: OrganizationReportSource<TeamPerformanceSource[], TeamResults> = {
  auditResource: "team_report",
  ...teamReportSources,
  capture: (repository, query) => repository.teamPerformance(query),
  summarize: (_currency, people) => ({ people })
};

export function getTeamPerformanceReport(actor: FinanceActorContext, raw: unknown, deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, raw, source, deps);
}
export function exportTeamPerformanceReport(actor: FinanceActorContext, raw: unknown, output: PerformanceExport<TeamPerformanceReport>,
  deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, raw, source, deps, output);
}
