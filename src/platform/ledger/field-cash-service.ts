import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { Money } from "@/platform/money/money";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { CashCustodyRepository } from "@/modules/finance/infrastructure/cash-custody-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { recheckFinanceAuthorization } from "@/modules/finance/application/finance-access";
import { cashCollectionPostings, cashCollectionRevision } from "@/modules/finance/domain/cash-custody";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { SyncRepository } from "@/modules/reservations/infrastructure/sync-repository";
import { requireAssignedOperationTask, operationAllowed, taskResource } from "@/modules/reservations/application/operation-service";
import { ReservationAuthorizationError, ReservationNotFoundError, type ReservationAuditMeta } from "@/modules/reservations/application/reservation-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { fieldCashPayloadSchema, fieldCashConfirmSchema, FieldCashConflictError, FieldCashUnavailableError, type FieldCashPayload, type FieldCashConfirm } from "./field-cash";

async function assignedCashContext(ctx: ReservationActorContext, taskId: string, tx: TenantTransaction) {
  const operations = new OperationRepository(tx, ctx.organizationId);
  if (ctx.authContext.organizationId !== ctx.organizationId || ctx.authContext.userAccountId !== ctx.actorId || ctx.authContext.personId !== ctx.personId)
    throw new ReservationAuthorizationError();
  await operations.lock(taskId);
  const repository = new CashCustodyRepository(tx, ctx.organizationId), clock = await repository.clock();
  ctx = { ...ctx, authContext: { ...(await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId)), personId: ctx.personId } };
  const task = await operations.task(taskId); requireAssignedOperationTask(ctx, task);
  operationAllowed(ctx, "view", taskResource(task));
  if (!["ASSIGNED", "IN_PROGRESS"].includes(task.state)) throw new ReservationNotFoundError();
  return { actor: ctx, task, repository, clock };
}
export async function recordFieldCashInTransaction(ctx: ReservationActorContext, raw: FieldCashPayload,
  transport: { deviceId: string; clientOpId: string; clientCreatedAt: Date | null }, tx: TenantTransaction, meta: ReservationAuditMeta) {
  const input = fieldCashPayloadSchema.parse(raw), context = await assignedCashContext(ctx, input.taskId, tx);
  ctx = context.actor; const { task, repository, clock } = context;
  const resource = { ...taskResource(task), id: clock.id, reservationId: task.reservationId,
    type: "cash_collection", dataClass: "financial" as const, amount: input.amount };
  if (!authorize(ctx.authContext, "create", resource, clock.now)) throw new ReservationAuthorizationError();
  const amount = Money.of(input.amount, input.currency), existing = await repository.operation(transport.deviceId, transport.clientOpId);
  const count = await repository.count(task.id), revision = cashCollectionRevision(task.id, task.version, count);
  if (existing) {
    if (existing.collectorUserAccountId !== ctx.actorId || existing.taskId !== task.id || !existing.amount.eq(amount.amount.toString()) || existing.currency !== input.currency ||
      existing.payer !== input.payer || existing.purpose !== input.purpose || existing.reportedRevision !== input.expectedRevision) throw new FieldCashUnavailableError("IDEMPOTENCY_KEY_REUSED");
    return { id: existing.id, serverVersion: revision, idempotent: true };
  }
  if (input.expectedRevision !== revision) throw new FieldCashConflictError(input.expectedRevision, revision);
  const currency = await repository.currency(input.currency);
  if (!currency || currency.minorUnit > 2 || amount.amount.decimalPlaces() > currency.minorUnit) throw new FieldCashUnavailableError("CURRENCY_UNAVAILABLE");
  const finance = new FinanceRepository(tx, ctx.organizationId), custodyCode = `CASH_CUSTODY_${ctx.personId.replaceAll("-", "").toUpperCase()}`;
  const [custody, unallocated] = await Promise.all([
    finance.ensureLedgerAccount({ code: custodyCode, name: custodyCode, accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
    finance.ensureLedgerAccount({ code: "UNALLOCATED_COLLECTIONS", name: "UNALLOCATED_COLLECTIONS", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" })
  ]);
  if (custody.archivedAt || unallocated.archivedAt || custody.accountType !== "ASSET_LOCATION" || custody.normalSide !== "DEBIT" ||
    unallocated.accountType !== "CLAIM_OWNERSHIP" || unallocated.normalSide !== "CREDIT") throw new FieldCashUnavailableError("ACCOUNT_UNAVAILABLE");
  const snapshot = task.reservationId ? await repository.financialSnapshot(task.reservationId) : null;
  const provenance = { taskVersion: task.version, taskType: task.type, reservationFinancialSnapshot: snapshot };
  const dimensions = { cashCollectionId: clock.id, taskId: task.id, propertyId: task.propertyId, reservationId: task.reservationId,
    collectorUserAccountId: ctx.actorId, collectorPersonId: ctx.personId, source: "CASH", purpose: input.purpose };
  const journal = await finance.createFinancialTransaction({ reference: `CASH:${clock.id}`, occurredAt: clock.now, description: input.purpose,
    idempotencyKey: `field-cash:${transport.deviceId}:${transport.clientOpId}`, createdBy: ctx.actorId,
    postings: cashCollectionPostings({ amount, custodyAccountId: custody.id, unallocatedAccountId: unallocated.id, dimensions }),
    recheckAuthorization: at => recheckFinanceAuthorization(ctx, tx, at, [
      { action: "view", resource: taskResource(task) }, { action: "create", resource }
    ], new ReservationAuthorizationError()) });
  const recorded = await repository.record({ id: clock.id, taskId: task.id, propertyId: task.propertyId, reservationId: task.reservationId,
    collectorUserAccountId: ctx.actorId, collectorPersonId: ctx.personId, custodyAccountId: custody.id, transactionId: journal.id,
    amount: amount.toJSON().amount, currency: input.currency, payer: input.payer, purpose: input.purpose,
    revision: count + 1n, reportedRevision: input.expectedRevision, deviceId: transport.deviceId, clientOpId: transport.clientOpId,
    clientCreatedAt: transport.clientCreatedAt, recordedAt: clock.now, provenance });
  const after = { ...dimensions, id: recorded.id, amount: amount.toJSON().amount, currency: input.currency, payer: input.payer,
    transactionId: journal.id, custodyAccountId: custody.id, city: resource.city, region: resource.region, provenance,
    untrustedClientCreatedAt: transport.clientCreatedAt?.toISOString() ?? null };
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "cash_collection.recorded", resourceType: "cash_collection",
    resourceId: recorded.id, propertyScopeId: task.propertyId, after, reason: input.purpose, requestId: meta.requestId,
    ipAddress: meta.ipAddress ?? null, deviceId: transport.deviceId, occurredAt: clock.now });
  await new OutboxRepository(tx, ctx.organizationId).append("PaymentReceived", { propertyId: task.propertyId, taskId: task.id,
    reservationId: task.reservationId, payment: { id: recorded.id, amount: amount.toJSON().amount, currency: input.currency,
      method: "CASH", collectorPersonId: ctx.personId, purpose: input.purpose, transactionId: journal.id } }, `cash:${recorded.id}:received`, clock.now);
  return { id: recorded.id, serverVersion: cashCollectionRevision(task.id, task.version, count + 1n), idempotent: false };
}

export async function confirmExistingFieldCashInTransaction(ctx: ReservationActorContext, raw: FieldCashConfirm,
  tx: TenantTransaction, meta: ReservationAuditMeta, deviceId: string) {
  const input = fieldCashConfirmSchema.parse(raw), context = await assignedCashContext(ctx, input.taskId, tx);
  ctx = context.actor; const { task, repository, clock } = context;
  const original = await new SyncRepository(tx, ctx.organizationId).findByClientOp(input.originalDeviceId, input.originalClientOpId);
  const receipt = await repository.receipt(input.receiptId), prior = fieldCashPayloadSchema.safeParse(original?.payload);
  if (!original || original.actorUserAccountId !== ctx.actorId || original.type !== "field_cash.collect" || original.status !== "CONFLICT" ||
    !prior.success || !receipt || receipt.collectorUserAccountId !== ctx.actorId || receipt.taskId !== task.id || prior.data.taskId !== task.id ||
    receipt.reportedRevision !== prior.data.expectedRevision || receipt.currency !== prior.data.currency || !receipt.amount.eq(prior.data.amount) ||
    receipt.payer !== prior.data.payer || receipt.purpose !== prior.data.purpose) throw new FieldCashUnavailableError("RECEIPT_MISMATCH");
  const resource = { ...taskResource(task), id: receipt.id, financialRecordId: receipt.transactionId, propertyId: receipt.propertyId,
    reservationId: receipt.reservationId, city: receipt.property.cityId ?? receipt.property.city, region: receipt.property.regionId ?? receipt.property.region,
    type: "cash_collection", amount: receipt.amount.toString(), dataClass: "financial" as const };
  if (!authorize(ctx.authContext, "view", resource, clock.now) || !authorize(ctx.authContext, "create", resource, clock.now)) throw new ReservationAuthorizationError();
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "cash_collection.duplicate_confirmed", resourceType: "cash_collection",
    resourceId: receipt.id, propertyScopeId: receipt.propertyId, reason: input.reason, requestId: meta.requestId, ipAddress: meta.ipAddress ?? null,
    deviceId, occurredAt: clock.now, after: { receiptId: receipt.id, taskId: task.id, originalDeviceId: input.originalDeviceId, originalClientOpId: input.originalClientOpId } });
  return { serverVersion: cashCollectionRevision(task.id, task.version, await repository.count(task.id)) };
}
