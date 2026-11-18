import type { Resource } from "@/platform/authz/authorize";
import { supplierPriceListPolicySchema } from "@/platform/config/supplier-price-list-policy";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { SupplierAlertRepository } from "@/modules/finance/infrastructure/supplier-alert-repository";
import { canReadSupplierAlert, supplierAlertResource, type SupplierAlertKind } from "@/modules/finance/domain/supplier-alert";
import { currentSupplierSlaBreaches } from "@/platform/maintenance/supplier-sla-milestones";
import { NotificationRepository } from "./notification-repository";

type Candidate = { target: Resource; referenceId: string; keys: string[] };
function changed(before: unknown, current: unknown) {
  const first = supplierPriceListPolicySchema.parse(before), next = supplierPriceListPolicySchema.parse(current);
  if (first.currency !== next.currency || first.items.length !== next.items.length) return true;
  const originals = new Map(first.items.map(item => [item.code, item]));
  return next.items.some(item => { const old = originals.get(item.code); return !old || old.amount !== item.amount || old.unit !== item.unit; });
}

export async function tickSupplierAlerts(organizationId: string, db: TenantTransactionRunner = prisma, observedAt?: Date) {
  let total = 0;
  for (const kind of ["supplier_prices_changed", "supplier_performance_alert"] as const) {
    let after: string | undefined;
    do {
      const page = await withTenant(db, organizationId, async tx => {
        const finance = new FinanceRepository(tx, organizationId), now = observedAt ?? await finance.clock();
        const alerts = new SupplierAlertRepository(tx, organizationId), notifications = new NotificationRepository(tx, organizationId);
        const entries: Candidate[] = [];
        let next: string | undefined;
        if (kind === "supplier_prices_changed") {
          const rows = await alerts.prices(now, after);
          for (const row of rows) if (row.previous && changed(row.previous, row.value)) {
            entries.push({ target: supplierAlertResource(organizationId, row), referenceId: row.id, keys: ["supplier-prices:" + row.id] });
          }
          next = rows.length === 50 ? rows.at(-1)?.supplierId : undefined;
        } else {
          const rows = await alerts.contractors(now, after);
          for (const row of rows) {
            const stages = await currentSupplierSlaBreaches(tx, organizationId, row, now);
            if (stages.length) entries.push({ target: supplierAlertResource(organizationId, row), referenceId: row.id,
              keys: stages.map(stage => "supplier-performance:" + row.id + ":" + stage) });
          }
          next = rows.length === 50 ? rows.at(-1)?.id : undefined;
        }
        const count = await publishAlerts(notifications, alerts, kind, entries, now);
        return { count, next };
      });
      total += page.count;
      after = page.next;
    } while (after);
  }
  return total;
}

async function publishAlerts(notifications: NotificationRepository, alerts: SupplierAlertRepository, kind: SupplierAlertKind,
  entries: Candidate[], now: Date) {
  const recorded = await alerts.recorded(entries.flatMap(entry => entry.keys));
  const pending = [];
  for (const entry of entries) {
    const keys = entry.keys.filter(key => !recorded.has(key));
    if (!keys.length) continue;
    const routing = await notifications.routing(kind, entry.target.propertyId ?? null, now);
    if (!routing.channels.length) continue;
    const viewers = await notifications.viewers(routing, entry.target);
    let recipientId: string | undefined;
    for (const id of viewers) {
      const context = await notifications.explicitRecipientContext(id, routing);
      if (context && canReadSupplierAlert(context, kind, entry.target, now)) { recipientId = id; break; }
    }
    if (recipientId) for (const key of keys) pending.push({ key, occurredAt: now, input: { kind, recipientId, targetId: entry.referenceId } });
  }
  await notifications.publishMany(pending);
  return pending.length;
}
