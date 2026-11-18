import { Temporal } from "temporal-polyfill";
import { calendarDateAt } from "@/i18n/format";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { assetWarrantyPolicyKey, assetWarrantyPolicySchema } from "../domain/warranty-alerts";
import { AssetRepository } from "../infrastructure/asset-repository";

export async function tickAssetWarrantyReminders(organizationId: string, db: TenantTransactionRunner = prisma) {
  let after: string | undefined;
  let reminders = 0;
  do {
    const page = await withTenant(db, organizationId, async tx => {
      const assets = new AssetRepository(tx, organizationId);
      const rules = new ConfigRuleRepository(tx, organizationId);
      const notices = new NotificationRepository(tx, organizationId);
      const now = await assets.clock();
      const rows = await assets.warrantiesEnding(now, after);
      const policies = await rules.resolveForProperties(assetWarrantyPolicyKey, [...new Set(rows.map(row => row.propertyId))], now);
      const entries = [];
      for (const row of rows) {
        const resolved = policies.get(row.propertyId);
        if (!resolved || !row.warrantyEndsOn) continue;
        const policy = assetWarrantyPolicySchema.parse(resolved.parsedValue);
        const today = Temporal.PlainDate.from(calendarDateAt(now, row.timezone));
        const remaining = today.until(Temporal.PlainDate.from(row.warrantyEndsOn)).days;
        const reached = policy.lead_days.filter(days => remaining <= days);
        if (!reached.length) continue;
        const leadDays = Math.min(...reached);
        const key = `asset-warranty:${row.id}:${row.warrantyEndsOn}:${leadDays}`;
        entries.push({ row, key });
      }
      const recorded = await assets.recordedWarrantyAlerts(entries.map(entry => entry.key));
      const pending = [];
      for (const { row, key } of entries) {
        if (recorded.has(key)) continue;
        const routing = await notices.routing("asset_warranty_expiring", row.propertyId, now);
        if (!routing.channels.length || (!routing.people.length && !routing.roles.length)) continue;
        const property = { type: "property", id: row.propertyId, organizationId, propertyId: row.propertyId,
          region: row.regionId, city: row.cityId, dataClass: "operational" } as const;
        const [propertyViewers, assetViewers] = await notices.viewerAudiences([
          { routing, resource: property },
          { routing, resource: { ...property, type: "asset", id: row.id } }
        ]);
        const recipientId = assetViewers.find(id => propertyViewers.includes(id));
        if (recipientId) pending.push({ key, occurredAt: now, input: {
          kind: "asset_warranty_expiring" as const, recipientId, targetId: row.revisionId
        } });
      }
      await notices.publishMany(pending);
      return { count: pending.length, next: rows.length === 50 ? rows.at(-1)?.id : undefined };
    });
    reminders += page.count;
    after = page.next;
  } while (after);
  return reminders;
}
