import { Money } from "@/platform/money/money";
import { OwnerMoneyMovementRepository, type OwnerMoneyRail } from "../infrastructure/owner-money-movement-repository";
import { readOwnerStatement } from "./owner-portal-service";

export async function getOwnerMoneyMovements(
  ctx: Parameters<typeof readOwnerStatement>[0], propertyId: string, period: Parameters<typeof readOwnerStatement>[2],
  page: number, deps: Parameters<typeof readOwnerStatement>[3] = {}
) {
  return readOwnerStatement(ctx, propertyId, period, deps, async (statement, tx) => {
    const sources = new OwnerMoneyMovementRepository(tx, ctx.organizationId);
    const rows = await sources.movements({ ownerId: statement.ownerId, propertyId, currency: statement.currency,
      periodStart: statement.periodStart, periodEnd: statement.periodEnd });
    const totals = new Map<OwnerMoneyRail, Money>();
    const zero = Money.zero(statement.currency);
    const movements = rows.map(row => {
      const money = Money.of(row.amount, statement.currency);
      const positive = row.rail === "ALVILLAS_PAYOUT" ? row.side === "DEBIT" : row.side === "CREDIT";
      const amount = positive ? money : zero.subtract(money);
      totals.set(row.rail, (totals.get(row.rail) ?? zero).add(amount));
      return { id: row.id, reference: row.reference, occurredAt: row.occurredAt, rail: row.rail, reversal: row.reversal, amount };
    });
    return { propertyName: statement.propertyName, from: statement.fromOn, to: statement.toOn, timezone: statement.timezone,
      currency: statement.currency, currencies: statement.currencies, payable: statement.closingBalance,
      payments: totals.get("ALVILLAS_PAYOUT") ?? zero, collected: [...totals].filter(([rail]) => rail !== "ALVILLAS_PAYOUT"),
      movements: movements.slice((page - 1) * 40, page * 40), more: movements.length > page * 40 };
  });
}
