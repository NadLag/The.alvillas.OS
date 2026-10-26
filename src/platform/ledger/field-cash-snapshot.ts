import { authorize, authorizeCollection, type Resource } from "@/platform/authz/authorize";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { CashCustodyRepository } from "@/modules/finance/infrastructure/cash-custody-repository";
import { cashCollectionRevision } from "@/modules/finance/domain/cash-custody";
import { fieldCashSnapshotSchema, type FieldCashSnapshot } from "./field-cash";

type Target = { id: string; version: number; resource: Resource; assigned: boolean; canEdit: boolean };
export async function fieldCashSnapshots(tx: TenantTransaction, ctx: ReservationActorContext, targets: Target[], asOf: Date, now: Date) {
  const result = new Map<string, FieldCashSnapshot>(), repo = new CashCustodyRepository(tx, ctx.organizationId);
  const canView = authorizeCollection(ctx.authContext, "view", "cash_collection");
  const eligible = targets.filter(target => target.assigned && (canView || authorize(ctx.authContext, "create",
    { ...target.resource, type: "cash_collection", id: undefined, dataClass: "financial", amount: "0" }, now)));
  if (!eligible.length) return result;
  const [currencies, positions] = await Promise.all([repo.currencies(), repo.positions(eligible.map(item => item.id), asOf)]);
  const histories = new Map<string, FieldCashSnapshot["receipts"]>(eligible.map(target => [target.id, []]));
  const byId = new Map(eligible.map(target => [target.id, target])), needed = new Set(eligible.map(target => target.id));
  let after: { at: Date; id: string } | undefined;
  // Bounded candidate batches preserve the latest permitted records even when
  // newer amounts or financial-record scopes are denied. No truncated scan.
  while (canView && needed.size) {
    const rows = await repo.ownReceipts([...needed], ctx.actorId, asOf, after);
    for (const row of rows) {
      const target = byId.get(row.taskId)!, history = histories.get(row.taskId)!;
      if (history.length >= 5 || !authorize(ctx.authContext, "view", { ...target.resource, type: "cash_collection", id: row.id,
        propertyId: row.propertyId, reservationId: row.reservationId, city: row.city, region: row.region,
        financialRecordId: row.transactionId, assignedUserAccountId: ctx.actorId, assignedPersonId: row.collectorPersonId,
        amount: row.amount, dataClass: "financial" }, now)) continue;
      history.push({ id: row.id, amount: row.amount, currency: row.currency, payer: row.payer, purpose: row.purpose, recordedAt: row.recordedAt.toISOString() });
      if (history.length === 5) needed.delete(row.taskId);
    }
    if (rows.length < 100) break;
    const last = rows.at(-1)!; after = { at: last.recordedAt, id: last.id };
  }
  for (const target of eligible) {
    const base = { ...target.resource, type: "cash_collection", id: undefined, dataClass: "financial" as const, amount: "0" };
    const canCollect = target.canEdit && ["ASSIGNED", "IN_PROGRESS"].includes(target.resource.status ?? "") && authorize(ctx.authContext, "create", base, now);
    const receipts = histories.get(target.id)!;
    const historyVisible = receipts.length > 0 || authorize(ctx.authContext, "view", base, now);
    if (!canCollect && !historyVisible) continue;
    result.set(target.id, fieldCashSnapshotSchema.parse({ ...currencies, revision: cashCollectionRevision(target.id, target.version, positions.get(target.id) ?? 0n),
      canCollect, historyVisible, receipts: historyVisible ? receipts : [] }));
  }
  return result;
}
