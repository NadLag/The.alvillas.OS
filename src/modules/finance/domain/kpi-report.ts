import { z } from "zod";
import { Money } from "@/platform/money/money";
import { exactReportPercent, performanceReportFilters, propertyReportTotals, type PerformanceMetric,
  type PortfolioNights, type PropertyPostingTotal } from "./performance-report";
import type { InventoryMoneyTotal, InventoryQuantityTotal } from "./inventory-performance-report";

const id = z.uuid().transform(value => value.toLowerCase());
export const kpiSelectKeys = ["ownerId", "personId", "roleId", "supplierId", "bookingSource"] as const;
export const kpiDimensionSchema = z.strictObject({
  ownerId: id.optional(),
  personId: id.optional(),
  roleId: id.optional(),
  supplierId: id.optional(),
  bookingSource: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u).optional()
});
export type KpiDimensions = z.infer<typeof kpiDimensionSchema>;
export type KpiSelectKey = typeof kpiSelectKeys[number];
export type KpiChoices = Record<KpiSelectKey, { id: string; name: string }[]>;

export const kpiPeriodSchema = z.string().regex(/^[1-9]\d{3}(?:-(?:0[1-9]|1[0-2]|Q[1-4]))?$/u);
export const kpiFilters = z.strictObject({
  ...performanceReportFilters.shape, ...kpiDimensionSchema.shape, period: kpiPeriodSchema.optional()
});

export function calendarKpiPeriod(period: string, today: string) {
  const [year, part] = period.split("-");
  const month = part?.startsWith("Q") ? Number(part.slice(1)) * 3 - 2 : part ? Number(part) : 1;
  const endMonth = !part ? 12 : part.startsWith("Q") ? month + 2 : month;
  const pad = (value: number) => String(value).padStart(2, "0");
  const fromOn = year + "-" + pad(month) + "-01";
  const endOn = year + "-" + pad(endMonth) + "-" + pad(new Date(Date.UTC(Number(year), endMonth, 0)).getUTCDate());
  return { fromOn, toOn: endOn < today ? endOn : today };
}

export type KpiOperations = {
  stays: string;
  completed: string;
  onTime: string;
  maintenanceOpen: string;
  maintenanceCompleted: string;
  maintenanceAverageMinutes: string | null;
  turnaroundMedianMinutes: string | null;
};
export type KpiLedger = {
  serviceGross: string | null;
  serviceCosts: string | null;
  maintenanceCost: string | null;
  cashBalances: string | null;
  varianceOpen: string | null;
  varianceAmount: string | null;
  varianceExpected: string | null;
};
export type KpiEvidence = {
  filters: KpiDimensions;
  choices: KpiChoices;
  postings: PropertyPostingTotal[] | null;
  nights: PortfolioNights[] | null;
  operations: KpiOperations;
  ledger: KpiLedger;
  inventoryMoney: InventoryMoneyTotal[];
  consumption: InventoryQuantityTotal[];
};
const count = (key: string, value: string | null): PerformanceMetric => ({ key, amount: null, count: value });
const ratio = (numerator: string, denominator: string) => {
  const value = exactReportPercent(BigInt(numerator), BigInt(denominator));
  return value === null ? null : value + "%";
};

export function kpiReportMetrics(currency: string, source: KpiEvidence) {
  const nights = source.nights?.reduce((result, row) => ({
    available: String(BigInt(result.available) + BigInt(row.available)),
    occupied: String(BigInt(result.occupied) + BigInt(row.occupied)),
    blocked: String(BigInt(result.blocked) + BigInt(row.blocked)),
    conflicts: String(BigInt(result.conflicts) + BigInt(row.conflicts))
  }), { available: "0", occupied: "0", blocked: "0", conflicts: "0" });
  const property = source.postings && nights ? propertyReportTotals(currency, source.postings, nights) : null;
  const amount = (key: string, value: Money | string | null | undefined): PerformanceMetric =>
    ({ key, amount: typeof value === "string" ? Money.of(value, currency) : value ?? null });
  const { ledger, operations, filters } = source;
  const serviceGross = ledger.serviceGross === null ? null : Money.of(ledger.serviceGross, currency);
  const breakdown = property?.amounts;
  const lodging = breakdown?.roomRevenue;
  const gross = lodging && !filters.ownerId ? lodging.add(serviceGross ?? Money.zero(currency)) : null;
  const expenses = breakdown?.operatingCosts;
  const occupancy = property?.occupancy;
  const openVariance = ledger.varianceAmount === null ? null : Money.of(ledger.varianceAmount, currency);
  const expectedVariance = ledger.varianceExpected === null ? null : Money.of(ledger.varianceExpected, currency);
  const cents = (value: Money) => value.toJSON().amount.replace(".", "");
  return {
    choices: source.choices,
    consumption: source.consumption,
    conflicts: nights?.conflicts,
    metrics: [
      count("occupancy", occupancy != null ? occupancy + "%" : null),
      amount("adr", property?.adr), amount("revpar", property?.revpar),
      amount("kpiGrossRevenue", gross),
      amount("kpiNetRevenue", gross && breakdown ? gross.subtract(breakdown.platformFees) : null),
      amount("platformFees", breakdown?.platformFees), amount("commission", breakdown?.commission),
      amount("ownerResult", breakdown ? breakdown.roomRevenue.add(breakdown.ownerServiceRevenue).subtract(breakdown.commission).subtract(breakdown.ownerExpenses) : null),
      amount("kpiServiceRevenue", serviceGross ?? (filters.ownerId ? breakdown?.ownerServiceRevenue : null)),
      amount("kpiServiceMargin", breakdown && ledger.serviceCosts !== null && !filters.ownerId
        ? breakdown.companyServiceRevenue.subtract(Money.of(ledger.serviceCosts, currency)) : null),
      amount("kpiExpensePerStay", expenses && !filters.ownerId && BigInt(operations.stays) > 0n
        ? expenses.multiplyRatio(1n, BigInt(operations.stays)) : null),
      amount("inventoryLaundryActual", source.inventoryMoney.find(row => row.key === "inventoryLaundryActual")?.amount),
      count("kpiCompleted", filters.supplierId ? null : operations.completed),
      count("kpiOnTimeRate", filters.supplierId ? null : ratio(operations.onTime, operations.completed)),
      count("kpiTurnaroundMinutes", filters.supplierId ? null : operations.turnaroundMedianMinutes),
      count("kpiMaintenanceOpen", filters.supplierId ? null : operations.maintenanceOpen),
      count("kpiMaintenanceCompleted", filters.supplierId ? null : operations.maintenanceCompleted),
      count("kpiMaintenanceMinutes", filters.supplierId ? null : operations.maintenanceAverageMinutes),
      amount("kpiMaintenanceCost", ledger.maintenanceCost),
      count("kpiVarianceOpen", ledger.varianceOpen),
      count("kpiVarianceRate", openVariance && expectedVariance ? ratio(cents(openVariance), cents(expectedVariance)) : null),
      amount("kpiCashBalance", ledger.cashBalances),
      amount("kpiOwnerCash", null), amount("kpiCompanyCash", null)
    ]
  };
}
