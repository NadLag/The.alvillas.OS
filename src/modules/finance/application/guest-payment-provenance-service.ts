import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { guestDepositRootSnapshot } from "../domain/guest-deposit-snapshot";
import { GuestDepositAuthorizationError } from "../domain/guest-deposit";
import { captureGuestPaymentProvenance, GuestPaymentProvenanceSourceError } from "../domain/guest-payment-provenance";
import { GuestPaymentProvenanceRepository } from "../infrastructure/guest-payment-provenance-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

/** Runs inside the original producer's transaction; committed historical receipts are never backfilled. */
export async function retainGuestPaymentProvenance(context: FinanceActorContext, tx: TenantTransaction, transactionId: string, requestId?: string) {
  const ctx = { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) }, repository = new GuestPaymentProvenanceRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new GuestDepositAuthorizationError();
  await recheckFinanceAuthorization(ctx, tx, await finance.clock(), [], new GuestDepositAuthorizationError());
  const original = await repository.source(z.uuid().parse(transactionId));
  if (!original || original.transaction.reversesTransactionId || original.transaction.createdBy !== ctx.actorId || original.audit.actorId !== ctx.actorId) throw new GuestPaymentProvenanceSourceError();
  const parsed = guestDepositRootSnapshot.safeParse(original.audit.after);
  if (!parsed.success) throw new GuestPaymentProvenanceSourceError();
  const snapshot = parsed.data, resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: transactionId, financialRecordId: transactionId,
    propertyId: snapshot.source.propertyId, reservationId: snapshot.source.reservationId, guestId: snapshot.source.guestId,
    city: snapshot.source.city ?? undefined, region: snapshot.source.region ?? undefined, amount: snapshot.input.amount, occurredAt: original.transaction.occurredAt, dataClass: "financial" as const };
  const recheck = () => finance.clock().then(at => recheckFinanceAuthorization(ctx, tx, at, [{ action: "view", resource }], new GuestDepositAuthorizationError()));
  await recheck();
  if (await repository.find(transactionId)) return;
  let originalSnapshotId: string | undefined;
  if (snapshot.operation === "ADMIT_CASH") {
    const cash = z.object({ reservationFinancialSnapshot: z.object({ id: z.uuid() }).strip() }).strip().safeParse(snapshot.cashSource.provenance);
    if (!cash.success) throw new GuestPaymentProvenanceSourceError();
    originalSnapshotId = cash.data.reservationFinancialSnapshot.id;
  }
  const [actor, booking, financialSnapshot] = await Promise.all([repository.actor(ctx.actorId), repository.booking(snapshot.source.reservationId), repository.financialSnapshot(snapshot.source.reservationId, originalSnapshotId)]);
  if (!actor || !booking || !financialSnapshot) throw new GuestPaymentProvenanceSourceError();
  const data = captureGuestPaymentProvenance({ organizationId: ctx.organizationId,
    transaction: { id: original.transaction.id, organizationId: original.transaction.organizationId, createdBy: original.transaction.createdBy },
    audit: { id: original.audit.id, actorId: original.audit.actorId }, actor, receipt: snapshot, booking: { ...booking, financialSnapshot } });
  await repository.deferGuards();
  const receipt = await repository.retain(data);
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.guest_payment.provenance_retained", resourceType: "financial_transaction", resourceId: transactionId,
    after: { receiptId: receipt.id, provenance: JSON.parse(JSON.stringify(data)) as Prisma.InputJsonObject }, reason: snapshot.input.reason, requestId: requestId ?? crypto.randomUUID(), occurredAt: await finance.clock() });
  // The original producer seals the journal and flushes every native guard after this complete witness is written.
  await recheck();
}
