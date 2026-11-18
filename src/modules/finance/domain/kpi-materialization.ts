import { z } from "zod";
import { calendarKpiPeriod } from "./kpi-report";

export const kpiRefreshKey = "finance.kpi_refresh";
const keys = ["CURRENT_MONTH", "CURRENT_QUARTER", "CURRENT_YEAR", "PREVIOUS_MONTH"] as const;
export type KpiMaterializationPeriod = typeof keys[number];
export const kpiRefreshPolicy = z.strictObject({
  refresh_minutes: z.number().int().min(5).max(1440),
  periods: z.array(z.enum(keys)).min(1).max(keys.length)
}).refine(value => new Set(value.periods).size === value.periods.length);

export function reportCalendarBounds(key: KpiMaterializationPeriod, today: string) {
  const year = today.slice(0, 4), month = today.slice(5, 7);
  if (key === "CURRENT_YEAR") return calendarKpiPeriod(year, today);
  if (key === "CURRENT_QUARTER") return calendarKpiPeriod(year + "-Q" + String(Math.ceil(Number(month) / 3)), today);
  if (key === "CURRENT_MONTH") return calendarKpiPeriod(today.slice(0, 7), today);
  const previous = new Date(Date.UTC(Number(year), Number(month) - 2, 1));
  return calendarKpiPeriod(previous.toISOString().slice(0, 7), today);
}
