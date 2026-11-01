import type { TenantTransaction } from "@/platform/db/tenant";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";

/** Reserve an unused historical month without closing another journey's financial period. */
export async function reserveHistoricalAccountingMonth(tx: TenantTransaction, organizationId: string, timezone: string) {
  const periods = new AccountingPeriodRepository(tx, organizationId);
  for (let attempt = 0; attempt < 36; attempt++) {
    const reference = await nextReferenceNumber(tx, organizationId, "EXP_ADJ_QA");
    const slot = Number(reference.split("-").at(-1));
    const month = new Date(Date.UTC(2025, -slot, 1)).toISOString().slice(0, 7);
    if (month < "2020-01") throw new Error("Historical financial acceptance calendar is exhausted; preserve all existing records");
    const bounds = await periods.bounds(month, timezone);
    if (!await periods.byMonth(month) && !await tx.financialTransaction.count({
      where: { occurredAt: { gte: bounds.startsAt, lt: bounds.endsAt } }
    })) return month;
  }
  throw new Error("No unused historical financial acceptance month is available; preserve all existing records");
}
