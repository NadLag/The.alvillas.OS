import { calendarDateAt } from "@/i18n/format";
import { Money } from "@/platform/money/money";
import type { OwnerStatementBucket } from "../domain/owner-statement";
import { readOwnerStatement } from "./owner-portal-service";
import { readOwnerMoneyMovementSnapshot } from "./owner-money-movements";
import { readOwnerPayoutSnapshot } from "./owner-payout-history";

const groups = {
  OWNER_REVENUE: "accommodation", OWNER_SERVICES: "services", COMMISSION: "commission", OTA_FEE: "platform",
  OWNER_EXPENSE: "expenses", REIMBURSEMENT: "reimbursements", PAYOUT: "payouts", ADJUSTMENT: "adjustments"
} as const satisfies Record<OwnerStatementBucket, string>;

export async function getOwnerFinancialReport(
  actor: Parameters<typeof readOwnerStatement>[0], propertyId: string, year: string, currency?: string,
  deps: Parameters<typeof readOwnerStatement>[3] = {}
) {
  return readOwnerStatement(actor, propertyId, { from: year + "-01-01", to: year + "-12-31", currency }, deps, async (statement, tx) => {
    const [funds, payouts] = await Promise.all([
      readOwnerMoneyMovementSnapshot(tx, actor.organizationId, statement, 1),
      readOwnerPayoutSnapshot(tx, actor.organizationId, statement, 1)
    ]);
    type Column = (typeof groups)[OwnerStatementBucket];
    const columns = Object.values(groups);
    const amounts = () => Object.fromEntries(columns.map(column => [column, Money.zero(statement.currency)])) as Record<Column, Money>;
    const rows = new Map<string, Record<Column, Money>>();
    for (const line of statement.lines) {
      const month = calendarDateAt(line.occurredAt, statement.timezone).slice(0, 7);
      const entry = rows.get(month) ?? amounts(), column = groups[line.bucket];
      entry[column] = entry[column].add(line.signedAmount);
      rows.set(month, entry);
    }
    return { propertyName: statement.propertyName, currency: statement.currency, currencies: statement.currencies,
      from: statement.fromOn, to: statement.toOn, columns, rows: [...rows].map(([month, amount]) => ({ month, amount })),
      totals: Object.entries(groups).map(([bucket, key]) => ({ key, amount: statement.bucketTotals[bucket as OwnerStatementBucket] })),
      funds: { payable: funds.payable, transferred: funds.payments, collected: funds.collected },
      payouts: { forecast: payouts.available ? payouts.plannedTotal : null } };
  });
}
