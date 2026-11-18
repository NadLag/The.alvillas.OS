import type { FinanceActorContext } from "./finance-access";
import { readOrganizationPerformance, type OrganizationReportPeriod, type OrganizationReportSource,
  type PerformanceExport, type PerformanceReportDeps } from "./organization-performance-report";
import { kpiReportSources } from "../domain/report-source-scope";
import { calendarKpiPeriod, kpiFilters, kpiReportMetrics, kpiSelectKeys, type KpiEvidence } from "../domain/kpi-report";
import { PerformanceReportAccessError } from "../domain/performance-report";

type KpiReport = ReturnType<typeof kpiReportMetrics> & OrganizationReportPeriod;
function buildKpiReport(input: unknown) {
  const { propertyId, currency, fromOn, toOn, period, ...selection } = kpiFilters.parse(input);
  const dimensions = Object.fromEntries(Object.entries({ ...selection, period }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const source: OrganizationReportSource<KpiEvidence, ReturnType<typeof kpiReportMetrics>> = {
    ...kpiReportSources,
    auditResource: "kpi_report",
    allowProperty: true,
    dimensions,
    resolveDates: period ? today => calendarKpiPeriod(period, today) : undefined,
    capture: async (repository, query) => {
      const kpi = repository.kpi(), inventory = repository.inventory();
      const choices = await kpi.choices();
      if (kpiSelectKeys.some(key => selection[key] && !choices[key].some(row => row.id === selection[key]))) throw new PerformanceReportAccessError();
      const { ownerId, personId, roleId, supplierId, bookingSource } = selection;
      const propertyMetrics = !personId && !roleId && !supplierId;
      const inventoryMetrics = !ownerId && !personId && !roleId && !bookingSource;
      const scope = { ...query, ownerId, bookingSource };
      const nightsSource = () => query.allowMaterialized && !query.propertyId && !ownerId && !bookingSource
        ? repository.materializedPortfolioNights(query) : repository.portfolioNights(query.fromOn, query.toOn, scope);
      const [postings, nights, operations, ledger, inventoryMoney, quantities] = await Promise.all([
        propertyMetrics ? repository.propertyPostings(scope) : null,
        propertyMetrics ? nightsSource() : null,
        kpi.operations(query, selection), kpi.ledger(query, selection),
        inventoryMetrics ? inventory.money({ ...query, supplierId }) : [],
        inventoryMetrics && !supplierId ? inventory.quantities(query) : []
      ]);
      return { filters: selection, choices, postings, nights, operations, ledger, inventoryMoney,
        consumption: quantities.filter(row => row.key === "inventoryConsumed") };
    },
    summarize: kpiReportMetrics
  };
  return { filters: { propertyId, currency, fromOn, toOn }, source };
}

export function getKpiReport(actor: FinanceActorContext, input: unknown, deps: PerformanceReportDeps = {}) {
  const { filters, source } = buildKpiReport(input);
  return readOrganizationPerformance(actor, filters, source, deps);
}

export function exportKpiReport(actor: FinanceActorContext, input: unknown, output: PerformanceExport<KpiReport>,
  deps: PerformanceReportDeps = {}) {
  const { filters, source } = buildKpiReport(input);
  return readOrganizationPerformance(actor, filters, source, deps, output);
}
