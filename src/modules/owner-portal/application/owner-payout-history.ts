import type { TenantTransaction } from "@/platform/db/tenant";
import type { OwnerStatementSnapshot } from "./owner-statement-presenter";
import { z } from "zod";
import { payoutCadenceSchema } from "@/platform/config/rule-registry";
import { Money } from "@/platform/money/money";
import { OwnerPayoutReadRepository } from "../infrastructure/owner-payout-read-repository";
import { readOwnerStatement } from "./owner-portal-service";

const payoutState = z.enum(["PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PAID", "RECONCILED", "FAILED", "CANCELLED"]);
const methodType = z.enum(["BANK_TRANSFER", "CASH", "CHEQUE", "PAYPAL", "MOBILE_MONEY"]);

export async function getOwnerPayoutHistory(
  ctx: Parameters<typeof readOwnerStatement>[0], propertyId: string, period: Parameters<typeof readOwnerStatement>[2],
  page: number, deps: Parameters<typeof readOwnerStatement>[3] = {}
) {
  return readOwnerStatement(ctx, propertyId, period, deps, (statement, tx) =>
    readOwnerPayoutSnapshot(tx, ctx.organizationId, statement, page));
}

export async function readOwnerPayoutSnapshot(
  tx: TenantTransaction, organizationId: string, statement: OwnerStatementSnapshot, page: number
) {
  const projected = await new OwnerPayoutReadRepository(tx, organizationId).rows({
    ownerId: statement.ownerId, propertyId: statement.propertyId, currency: statement.currency, from: statement.periodStart, to: statement.periodEnd
  });
  let plannedTotal = Money.zero(statement.currency), transferredTotal = Money.zero(statement.currency);
  const rows = (projected ?? []).flatMap(row => {
    const state = payoutState.safeParse(row.state);
    if (!state.success) return [];
    const cadence = payoutCadenceSchema.safeParse(row.cadence), method = methodType.safeParse(row.method);
    const amount = Money.of(row.amount, statement.currency);
    const planned = ["PENDING_APPROVAL", "APPROVED", "SCHEDULED"].includes(state.data) &&
      row.futureCurrency === statement.currency && row.futureAmount === amount.toJSON().amount ? amount : null;
    const transferred = row.confirmedAt ? amount : null;
    if (planned) plannedTotal = plannedTotal.add(planned);
    if (transferred) transferredTotal = transferredTotal.add(transferred);
    return [{ id: row.id, state: !row.confirmedAt && (state.data === "PAID" || state.data === "RECONCILED") ? "AWAITING_EVIDENCE" as const : state.data,
      method: method.success ? method.data : "OTHER" as const, cadence: cadence.success ? cadence.data : null, planned, transferred,
      eligibleAt: row.eligibleAt, scheduledFor: row.scheduledFor, expectedAt: row.expectedAt, confirmedAt: row.confirmedAt,
      approvalSteps: row.approvalSteps, referenceSuffix: row.referenceSuffix }];
  });
  return { propertyName: statement.propertyName, timezone: statement.timezone, currency: statement.currency, currencies: statement.currencies,
    from: statement.fromOn, to: statement.toOn, available: projected !== null, plannedTotal, transferredTotal,
    rows: rows.slice((page - 1) * 40, page * 40), more: rows.length > page * 40 };
}
