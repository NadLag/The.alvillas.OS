import { inventoryReportSources } from "../domain/report-source-scope";
import type { FinanceActorContext } from "./finance-access";
import { readOrganizationPerformance, type OrganizationReportPeriod, type OrganizationReportSource,
  type PerformanceExport, type PerformanceReportDeps } from "./organization-performance-report";
import { inventoryReportMoney, type InventoryMoneyTotal, type InventoryQuantityTotal } from "../domain/inventory-performance-report";

type InventorySources = { quantities: InventoryQuantityTotal[]; money: InventoryMoneyTotal[] };
type InventoryPerformance = ReturnType<typeof summarize>;

function summarize(currency: string, source: InventorySources) {
  return { quantities: source.quantities, monetaryMetrics: inventoryReportMoney(source.money, currency) };
}

const inventoryReport: OrganizationReportSource<InventorySources, InventoryPerformance> = {
  ...inventoryReportSources,
  auditResource: "inventory_report",
  allowProperty: true,
  capture: async (repository, query) => {
    const inventory = repository.inventory();
    const [quantities, money] = await Promise.all([inventory.quantities(query), inventory.money(query)]);
    return { quantities, money };
  },
  summarize
};

export function getInventoryPerformanceReport(actor: FinanceActorContext, input: unknown, deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, input, inventoryReport, deps);
}

export function exportInventoryPerformanceReport(actor: FinanceActorContext, input: unknown,
  output: PerformanceExport<InventoryPerformance & OrganizationReportPeriod>, deps: PerformanceReportDeps = {}) {
  return readOrganizationPerformance(actor, input, inventoryReport, deps, output);
}
