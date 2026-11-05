import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { calendarDateAt } from "@/i18n/format";
import { providerCaptureSettlementSchema } from "@/platform/providers/payment-capture";
import { externalPaymentFeeDraftInput } from "../domain/external-payment-command";
import { ExternalPaymentIntentError } from "../domain/external-payment-intent";
import { ExternalPaymentRepository } from "../infrastructure/external-payment-repository";
import { ExternalPaymentFeeRepository } from "../infrastructure/external-payment-fee-repository";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { externalPaymentContext } from "./external-payment-service";
import { authorizeExternalPaymentSource, type ExternalPaymentRequest } from "./external-payment-access";
import { createExpenseDraft, recheckExpenseDraftCreation } from "./expense-service";
import { nativeTransaction } from "./native-payment-providers";
import type { FinanceActorContext } from "./finance-access";
import { recheckFinanceAuthorization } from "./finance-access";
import { expenseResource } from "../domain/expense";
import { PaymentMethodAccessError } from "../domain/payment-method";

export async function authorizeExternalPaymentFee(ctx: FinanceActorContext, tx: TenantTransaction, request: ExternalPaymentRequest,
  fee: NonNullable<Awaited<ReturnType<ExternalPaymentFeeRepository["byCapture"]>>>, pay = false) {
  if (!request.capture?.capturedAt || fee.captureId !== request.capture.id || fee.createdBy !== request.requestedBy) throw new ExternalPaymentIntentError();
  const source = await authorizeExternalPaymentSource(ctx, tx, request), row = await new ExpenseRepository(tx, ctx.organizationId).find(fee.expenseId);
  if (!row) throw new ExternalPaymentIntentError();
  const resource = expenseResource(ctx.organizationId, { ...row.property, timezone: fee.propertyTimezone }, { ...row, amount: row.amount.toString(), occurredAt: request.capture.capturedAt });
  await recheckFinanceAuthorization(ctx, tx, source.now, [{ action: "view", resource }, ...pay ? [{ action: "pay" as const, resource }] : [],
    ...row.transactionId ? [{ action: "view" as const, resource: { ...resource, type: "financial_transaction", id: row.transactionId, financialRecordId: row.transactionId, occurredAt: row.transaction!.occurredAt } }] : []], new PaymentMethodAccessError());
  return row;
}

/** No automatic cost owner: the ordinary configured expense treatment and approval workflow decides allocation. */
export async function prepareExternalPaymentFee(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalPaymentFeeDraftInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExternalPaymentRepository(tx, ctx.organizationId); await repository.lock(input.intentId);
    const request = await repository.find(input.intentId), settlement = providerCaptureSettlementSchema.safeParse(request?.capture?.settlement);
    if (!request?.capture?.capturedAt || !settlement.success || !Money.of(settlement.data.fee.amount, settlement.data.fee.currency).amount.gt(0)) throw new ExternalPaymentIntentError();
    const source = await authorizeExternalPaymentSource(ctx, tx, request, true), expenses = new ExpenseRepository(tx, ctx.organizationId), property = await expenses.property(source.source.propertyId);
    if (!property) throw new ExternalPaymentIntentError();
    const draft = { propertyId: source.source.propertyId, reservationId: request.reservationId, fundingAccountId: request.accountId,
      amount: settlement.data.fee.amount, currency: settlement.data.fee.currency, category: input.category, purpose: input.purpose,
      occurredOn: calendarDateAt(request.capture.capturedAt, property.timezone), emergency: false, idempotencyKey: request.capture.id, reason: input.reason };
    const fees = new ExternalPaymentFeeRepository(tx, ctx.organizationId), original = await fees.byCapture(request.capture.id);
    if (original) {
      if (original.createdBy !== ctx.actorId || original.expense.category !== input.category || original.expense.purpose !== input.purpose) throw new ExternalPaymentIntentError();
      await authorizeExternalPaymentFee(ctx, tx, request, original);
      return { id: original.expenseId, version: original.expense.version, state: original.expense.state, idempotent: true };
    }
    const actualTarget = expenseResource(ctx.organizationId, property, { id: request.capture.id, amount: draft.amount, reservationId: draft.reservationId,
      state: "DRAFT", occurredOn: new Date(draft.occurredOn + "T00:00:00.000Z"), occurredAt: request.capture.capturedAt, createdBy: ctx.actorId });
    await recheckFinanceAuthorization(ctx, tx, source.now, [{ action: "create", resource: actualTarget }], new PaymentMethodAccessError());
    await recheckExpenseDraftCreation(ctx, tx, draft, request.capture.id);
    const created = await createExpenseDraft(ctx, draft, { db: nativeTransaction(tx), requestId: deps.requestId });
    if (created.idempotent) throw new ExternalPaymentIntentError();
    await fees.create({ captureId: request.capture.id, expenseId: created.id, createdBy: ctx.actorId, propertyTimezone: property.timezone });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, resourceType: "financial_transaction", resourceId: request.id,
      action: "finance.external_payment.fee_prepared", after: { intentId: request.id, captureId: request.capture.id, expenseId: created.id, fee: settlement.data.fee, propertyTimezone: property.timezone },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: (await expenses.clock()).now });
    await recheckExpenseDraftCreation(ctx, tx, draft, created.id); await authorizeExternalPaymentSource(ctx, tx, request, true);
    await recheckFinanceAuthorization(ctx, tx, (await expenses.clock()).now, [{ action: "create", resource: { ...actualTarget, id: created.id, financialRecordId: created.id } }], new PaymentMethodAccessError());
    return { id: created.id, version: created.version, state: "DRAFT" as const, idempotent: false };
  });
}
