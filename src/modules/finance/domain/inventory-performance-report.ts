import { Money } from "@/platform/money/money";
import type { AppLocale } from "@/i18n/routing";
import type { PerformanceMetric } from "./performance-report";

export type InventoryQuantityTotal = {
  itemId: string;
  itemKey: string;
  labels: unknown;
  unit: string | null;
  key: string;
  quantity: string;
};

export type InventoryMoneyTotal = { key: string; amount: string | null };

export function inventoryReportItems(rows: InventoryQuantityTotal[], locale: AppLocale) {
  const items = new Map<string, { id: string; name: string; unit: string | null; metrics: PerformanceMetric[] }>();
  for (const row of rows) {
    const labels = row.labels as Partial<Record<AppLocale, unknown>> | null;
    const name = [labels?.[locale], labels?.en, labels?.fr].find((label): label is string => typeof label === "string") ?? row.itemKey;
    const item = items.get(row.itemId) ?? { id: row.itemId, name, unit: row.unit, metrics: [] };
    item.metrics.push({ key: row.key, amount: null, count: row.quantity,
      subject: { id: item.id, name: [name, row.unit].filter(Boolean).join(" · ") } });
    items.set(item.id, item);
  }
  return [...items.values()];
}

export function inventoryReportMoney(rows: InventoryMoneyTotal[], currency: string): PerformanceMetric[] {
  return rows.map(({ key, amount }) => ({ key, amount: amount === null ? null : Money.of(amount, currency) }));
}
