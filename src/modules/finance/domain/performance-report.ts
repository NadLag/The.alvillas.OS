import { z } from "zod";
import { Money } from "@/platform/money/money";

export const performanceReportFilters = z.strictObject({
  propertyId: z.uuid().transform(value => value.toLowerCase()).optional(),
  fromOn: z.iso.date().optional(),
  toOn: z.iso.date().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/u).optional()
}).refine(value => !value.fromOn || !value.toOn || value.fromOn <= value.toOn);

export class PerformanceReportAccessError extends Error {}
export class PerformanceReportUnavailableError extends Error {}

export const propertyPostingKeys = [
  "roomRevenue", "ownerServiceRevenue", "commission", "platformFees", "ownerExpenses",
  "reimbursements", "companyServiceRevenue", "operatingCosts"
] as const;

type PropertyPostingKey = typeof propertyPostingKeys[number];
export type PropertyPostingTotal = { key: PropertyPostingKey; amount: string };
export type PropertyNightTotals = { available: string; occupied: string; blocked: string; conflicts: string };

export function propertyReportTotals(currency: string, source: PropertyPostingTotal[], nights: PropertyNightTotals) {
  const posted = new Map(source.map(row => [row.key, Money.of(row.amount, currency)]));
  const amount = (key: PropertyPostingKey) => posted.get(key) ?? Money.zero(currency);
  const ownerResult = amount("roomRevenue").add(amount("ownerServiceRevenue")).add(amount("reimbursements"))
    .subtract(amount("commission")).subtract(amount("platformFees")).subtract(amount("ownerExpenses"));
  const occupied = BigInt(nights.occupied), available = BigInt(nights.available);
  const ratiosAvailable = nights.conflicts === "0";
  return {
    amounts: Object.fromEntries(propertyPostingKeys.map(key => [key, amount(key)])) as Record<PropertyPostingKey, Money>,
    ownerResult,
    adr: ratiosAvailable && occupied > 0n ? amount("roomRevenue").multiplyRatio(1n, occupied) : null,
    revpar: ratiosAvailable && available > 0n ? amount("roomRevenue").multiplyRatio(1n, available) : null,
    occupancy: ratiosAvailable && available > 0n ? exactReportPercent(occupied, available) : null,
    ...nights
  };
}

export function exactReportPercent(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) return null;
  const negative = numerator < 0n, absolute = (negative ? -numerator : numerator) * 10000n;
  const hundredths = (absolute + denominator / 2n) / denominator;
  return (negative && hundredths > 0n ? "-" : "") + String(hundredths / 100n) + "." + String(hundredths % 100n).padStart(2, "0");
}

export type PerformanceMetric = { key: string; amount: Money | null; count?: string | null; subject?: { id: string; name: string } };


export function propertyReportMetrics(report: ReturnType<typeof propertyReportTotals>) {
  return {
    financial: [
      ...propertyPostingKeys.map(key => ({ key, amount: report.amounts[key] })),
      { key: "ownerResult", amount: report.ownerResult }
    ] satisfies PerformanceMetric[],
    occupancy: [
      { key: "occupied", count: report.occupied, amount: null },
      { key: "available", count: report.available, amount: null },
      { key: "blocked", count: report.blocked, amount: null },
      { key: "conflicts", count: report.conflicts, amount: null },
      { key: "occupancy", count: report.occupancy === null ? null : report.occupancy + "%", amount: null },
      { key: "adr", amount: report.adr },
      { key: "revpar", amount: report.revpar }
    ] satisfies PerformanceMetric[]
  };
}

export const companyPostingKeys = ["commission", "companyServiceRevenue", "operatingCosts", "bankBalance", "cashBalance"] as const;
type CompanyPostingKey = typeof companyPostingKeys[number];
export type CompanyPostingTotal = { key: CompanyPostingKey; amount: string; propertyId: string | null };
export type PortfolioNights = PropertyNightTotals & { propertyId: string; propertyName: string };

export function companyReportTotals(currency: string, source: CompanyPostingTotal[], portfolio: PortfolioNights[]) {
  const zero = Money.zero(currency);
  const totals = new Map<CompanyPostingKey, Money>();
  const byProperty = new Map<string, Map<CompanyPostingKey, Money>>();
  for (const row of source) {
    const value = Money.of(row.amount, currency);
    totals.set(row.key, (totals.get(row.key) ?? zero).add(value));
    if (row.propertyId) {
      const current = byProperty.get(row.propertyId) ?? new Map<CompanyPostingKey, Money>();
      current.set(row.key, (current.get(row.key) ?? zero).add(value));
      byProperty.set(row.propertyId, current);
    }
  }

  const amount = (key: CompanyPostingKey) => totals.get(key) ?? zero;
  const revenue = amount("commission").add(amount("companyServiceRevenue"));
  const profit = revenue.subtract(amount("operatingCosts"));
  const profitCents = BigInt(profit.toJSON().amount.replace(".", ""));
  const revenueCents = BigInt(revenue.toJSON().amount.replace(".", ""));
  const margin = exactReportPercent(profitCents, revenueCents);
  const properties = portfolio.map(row => {
    const money = byProperty.get(row.propertyId);
    const revenue = (money?.get("commission") ?? zero).add(money?.get("companyServiceRevenue") ?? zero);
    const expense = money?.get("operatingCosts") ?? zero;
    const occupancy = row.conflicts === "0" ? exactReportPercent(BigInt(row.occupied), BigInt(row.available)) : null;
    return { ...row, revenue, expense, profit: revenue.subtract(expense), occupancy };
  });
  const propertyRevenue = properties.reduce((total, row) => total.add(row.revenue), zero);
  const propertyExpenses = properties.reduce((total, row) => total.add(row.expense), zero);
  return {
    amounts: Object.fromEntries(companyPostingKeys.map(key => [key, amount(key)])) as Record<CompanyPostingKey, Money>,
    revenue, profit, margin, cashPosition: amount("bankBalance").add(amount("cashBalance")), properties,
    outsidePortfolio: revenue.subtract(propertyRevenue).subtract(amount("operatingCosts").subtract(propertyExpenses))
  };
}

export function companyReportMetrics(report: ReturnType<typeof companyReportTotals>) {
  const { bankBalance, cashBalance, ...postings } = report.amounts;
  return {
    financial: [
      ...Object.entries(postings).map(([key, amount]) => ({ key, amount })),
      { key: "companyRevenue", amount: report.revenue },
      { key: "companyProfit", amount: report.profit },
      { key: "companyMargin", amount: null, count: report.margin === null ? null : report.margin + "%" },
      { key: "outsidePortfolio", amount: report.outsidePortfolio }
    ] satisfies PerformanceMetric[],
    cash: [
      { key: "bankBalance", amount: bankBalance },
      { key: "cashBalance", amount: cashBalance },
      { key: "cashPosition", amount: report.cashPosition }
    ] satisfies PerformanceMetric[]
  };
}

export type TeamPerformanceSource = { id: string; name: string; assigned: string; open: string; completed: string;
  onTime: string; recognized: string; walletDebits: string; walletCredits: string };

export function teamReportMetrics(row: TeamPerformanceSource, currency: string): PerformanceMetric[] {
  const onTime = exactReportPercent(BigInt(row.onTime), BigInt(row.completed));
  const subject = { id: row.id, name: row.name };
  return [
    { key: "scheduledJobs", count: row.assigned, amount: null },
    { key: "openJobs", count: row.open, amount: null },
    { key: "completedJobs", count: row.completed, amount: null },
    { key: "onTimeJobs", count: onTime === null ? null : onTime + "%", amount: null },
    { key: "recognizedCompensation", amount: Money.of(row.recognized, currency) },
    { key: "walletDebits", amount: Money.of(row.walletDebits, currency) },
    { key: "walletCredits", amount: Money.of(row.walletCredits, currency) }
  ].map(metric => ({ ...metric, subject }));
}
