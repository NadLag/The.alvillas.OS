import { z } from "zod";
import { Money } from "@/platform/money/money";

export const performanceReportFilters = z.strictObject({
  propertyId: z.uuid().optional(),
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
  const percent = available > 0n ? (occupied * 10000n + available / 2n) / available : 0n;
  return {
    amounts: Object.fromEntries(propertyPostingKeys.map(key => [key, amount(key)])) as Record<PropertyPostingKey, Money>,
    ownerResult,
    adr: ratiosAvailable && occupied > 0n ? amount("roomRevenue").multiplyRatio(1n, occupied) : null,
    revpar: ratiosAvailable && available > 0n ? amount("roomRevenue").multiplyRatio(1n, available) : null,
    occupancy: ratiosAvailable && available > 0n ? String(percent / 100n) + "." + String(percent % 100n).padStart(2, "0") : null,
    ...nights
  };
}

export type PerformanceMetric = { key: string; amount: Money | null; count?: string | null };

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
