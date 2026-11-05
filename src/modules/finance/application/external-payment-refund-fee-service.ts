import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { providerRefundSettlementSchema } from "@/platform/providers/payment-refund-settlement";
import { externalRefundIdentityInput } from "../domain/external-payment-refund-command";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { providerRefundFeeCorrectionTarget } from "../domain/provider-refund-fee-correction";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { ExternalPaymentRefundFeeRepository } from "../infrastructure/external-payment-refund-fee-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { ExpenseRepository, type ExpenseRecord } from "../infrastructure/expense-repository";
import { expenseResource } from "../domain/expense";
import { externalPaymentContext } from "./external-payment-service";
import { authorizeExternalRefundSourceView, retainedExternalRefund } from "./external-payment-refund-access";
import { createExpenseCorrectionDraft } from "./expense-service";
import { nativeTransaction } from "./native-payment-providers";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { postExpense, voidExpense } from "./expense-posting-service";

type Refund = NonNullable<Awaited<ReturnType<ExternalPaymentRefundRepository["find"]>>>;
async function currentCostSource(fees: ExternalPaymentRefundFeeRepository, captureId: string) {
  const source = await fees.source(captureId), chain = await fees.chain(captureId);
  if (!source?.expense.transactionId) throw new ExternalPaymentRefundError();
  let head = source.expense;
  const visited = new Set<string>();
  for (;;) {
    const next = chain.find(binding => binding.originalExpenseId === head.id);
    if (!next) break;
    if (visited.has(next.id) || !next.correctionExpense || !await fees.isPosted(next.refundIntentId)) throw new ExternalPaymentRefundError();
    visited.add(next.id); head = next.correctionExpense;
  }
  if (visited.size !== chain.length || head.state !== "POSTED" || !head.transactionId) throw new ExternalPaymentRefundError();
  return { source, head };
}
export async function authorizeExternalRefundFee(ctx: FinanceActorContext, tx: TenantTransaction, request: Refund, sourceId: string, amount: Money, targetId?: string, sourceSnapshot?: ExpenseRecord) {
  const repository = new ExpenseRepository(tx, ctx.organizationId), source: ExpenseRecord | null = sourceSnapshot ?? await repository.find(sourceId);
  if (!source?.transactionId || !source.transaction || !request.identity) throw new ExternalPaymentRefundError();
  const first = await new GuestDepositRepository(tx, ctx.organizationId).firstCompletedExternalRefund(request.identity.id);
  if (!first?.refundedAt) throw new ExternalPaymentRefundError();
  const old = expenseResource(ctx.organizationId, source.property, { ...source, amount: source.amount.toString(), occurredAt: source.transaction.occurredAt }),
    journal = { ...old, type: "financial_transaction" as const, id: source.transactionId, financialRecordId: source.transactionId },
    next = { ...old, id: targetId ?? request.id, financialRecordId: targetId ?? request.id, status: "DRAFT", assignedUserAccountId: ctx.actorId, amount: amount.toJSON().amount, occurredAt: first.refundedAt };
  for (const actor of [ctx, { ...ctx, authContext: restoreAuthorizationCap(request.authorizationCap) }]) {
    await recheckFinanceAuthorization(actor, tx, (await repository.clock()).now, [{ action: "view", resource: old }, { action: "view", resource: journal },
      { action: "override", resource: journal }, { action: "void", resource: old }, { action: "void", resource: journal },
      { action: "view", resource: { ...journal, id: source.fundingAccountId, financialRecordId: source.fundingAccountId } },
      { action: "view", resource: { ...journal, id: source.fundingAccountId, financialRecordId: source.fundingAccountId, occurredAt: first.refundedAt } },
      { action: "create", resource: { ...journal, id: request.id, financialRecordId: request.id, occurredAt: first.refundedAt } },
      ...amount.amount.gt(0) ? [{ action: "view" as const, resource: next }, { action: "create" as const, resource: next }] : []], new ExternalPaymentRefundError());
  }
  return source;
}

export async function inspectExternalRefundFeeAdmission(ctx: FinanceActorContext, tx: TenantTransaction, request: Refund) {
  const settlement = providerRefundSettlementSchema.safeParse(request.identity?.observations[0]?.settlement?.settlement);
  if (!settlement.success) throw new ExternalPaymentRefundError();
  if (Money.of(settlement.data.fee.amount, settlement.data.fee.currency).amount.isZero()) return null;
  const fees = new ExternalPaymentRefundFeeRepository(tx, ctx.organizationId), binding = await fees.byRefund(request.id);
  if (!binding || binding.createdBy !== ctx.actorId || binding.returnedFee.toFixed(2) !== settlement.data.fee.amount || binding.currency !== settlement.data.fee.currency ||
    binding.originalExpense.state !== "POSTED" || binding.originalExpense.version !== binding.originalExpenseVersion ||
    binding.correctionExpense && binding.correctionExpense.state !== "APPROVED") throw new ExternalPaymentRefundError();
  await fees.isPosted(request.id); // Validates committed provenance independently of caller input before any cost movement.
  const amount = Money.of(binding.remainingCost.toString(), binding.currency), source = await authorizeExternalRefundFee(ctx, tx, request, binding.originalExpenseId, amount, binding.correctionExpenseId ?? undefined),
    correction = binding.correctionExpense ? await new ExpenseRepository(tx, ctx.organizationId).find(binding.correctionExpense.id) : null,
    at = request.identity ? await new GuestDepositRepository(tx, ctx.organizationId).firstCompletedExternalRefund(request.identity.id) : null;
  if (!at?.refundedAt || correction && (!correction.submission || correction.approval && (correction.approval.state !== "APPROVED" || correction.approval.financialStages.some(stage => stage.state !== "APPROVED")))) throw new ExternalPaymentRefundError();
  const payTarget = correction ? expenseResource(ctx.organizationId, correction.property, { ...correction, amount: correction.amount.toString(), occurredAt: at.refundedAt }) : null;
  const recheck = async () => {
    await authorizeExternalRefundSourceView(ctx, tx, request);
    await authorizeExternalRefundFee(ctx, tx, request, source.id, amount, correction?.id, source);
    if (payTarget) for (const actor of [ctx, { ...ctx, authContext: restoreAuthorizationCap(request.authorizationCap) }]) await recheckFinanceAuthorization(actor, tx, (await new ExpenseRepository(tx, ctx.organizationId).clock()).now,
      [{ action: "view", resource: payTarget }, { action: "pay", resource: payTarget }], new ExternalPaymentRefundError());
  };
  await recheck();
  return { binding, correction, recheck, fingerprint: { bindingId: binding.id, originalExpenseId: source.id, originalExpenseVersion: binding.originalExpenseVersion,
    correctionExpenseId: correction?.id ?? null, correctionVersion: correction?.version ?? null, returnedFee: settlement.data.fee, remainingCost: amount.toJSON(), refundedAt: at.refundedAt.toISOString() } };
}

export async function postExternalRefundFeeAdmission(ctx: FinanceActorContext, tx: TenantTransaction, request: Refund, prepared: NonNullable<Awaited<ReturnType<typeof inspectExternalRefundFeeAdmission>>>, requestId?: string) {
  const saved = retainedExternalRefund(request, ctx); await prepared.recheck();
  if (prepared.correction) await postExpense(ctx, { id: prepared.correction.id, expectedVersion: prepared.correction.version, reason: saved.input.refund.reason }, { db: nativeTransaction(tx), requestId });
  else await voidExpense(ctx, { id: prepared.binding.originalExpenseId, expectedVersion: prepared.binding.originalExpenseVersion, reason: saved.input.refund.reason }, { db: nativeTransaction(tx), requestId });
  await prepared.recheck();
}

export async function readExternalPaymentRefundFee(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundIdentityInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const request = await new ExternalPaymentRefundRepository(tx, ctx.organizationId).find(input.intentId);
    if (!request) throw new ExternalPaymentRefundError();
    await authorizeExternalRefundSourceView(ctx, tx, request);
    const settlement = providerRefundSettlementSchema.safeParse(request.identity?.observations[0]?.settlement?.settlement), fees = new ExternalPaymentRefundFeeRepository(tx, ctx.organizationId);
    if (request.identity?.observations[0]?.state !== "COMPLETED" || !settlement.success || !Money.of(settlement.data.fee.amount, settlement.data.fee.currency).amount.gt(0)) throw new ExternalPaymentRefundError();
    const binding = await fees.byRefund(request.id);
    if (binding && (binding.returnedFee.toFixed(2) !== settlement.data.fee.amount || binding.currency !== settlement.data.fee.currency)) throw new ExternalPaymentRefundError();
    const current = binding ? null : await currentCostSource(fees, request.captureId),
      target = binding ? Money.of(binding.remainingCost.toString(), binding.currency) : providerRefundFeeCorrectionTarget({ originalFee: Money.of(current!.source.expense.amount.toString(), current!.source.expense.currency),
        currentCost: Money.of(current!.head.amount.toString(), current!.head.currency), gross: Money.of(request.amount.toString(), request.currency), returnedFee: Money.of(settlement.data.fee.amount, settlement.data.fee.currency), merchantDebit: Money.of(settlement.data.net.amount, settlement.data.net.currency) }).remainingCost,
      source = await authorizeExternalRefundFee(ctx, tx, request, binding?.originalExpenseId ?? current!.head.id, target, binding?.correctionExpenseId ?? undefined), repository = new ExpenseRepository(tx, ctx.organizationId), now = (await repository.clock()).now,
      resource = expenseResource(ctx.organizationId, source.property, { ...source, amount: source.amount.toString(), occurredAt: source.transaction!.occurredAt }),
      data = { intentId: request.id, bindingId: binding?.id ?? null, expenseId: binding?.correctionExpenseId ?? null, state: binding ? binding.correctionExpense?.state ?? "READY" : "UNPREPARED",
        returnedFee: settlement.data.fee, remainingCost: target.toJSON() };
    const result = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...resource, data }, {}, now) as typeof data;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_fee_reviewed", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, bindingId: binding?.id ?? null }, reason: "Reviewed verified provider fee credit and the original native expense correction", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: (await repository.clock()).now });
    await authorizeExternalRefundSourceView(ctx, tx, request); await authorizeExternalRefundFee(ctx, tx, request, source.id, target, binding?.correctionExpenseId ?? undefined, source); return result;
  });
}

/** Prepare the ordinary correction with the original agreement; never guess who bears a provider fee. */
export async function prepareExternalPaymentRefundFee(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundIdentityInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const refunds = new ExternalPaymentRefundRepository(tx, ctx.organizationId), request = await refunds.find(input.intentId);
    if (!request) throw new ExternalPaymentRefundError();
    const saved = retainedExternalRefund(request, ctx), deposits = new GuestDepositRepository(tx, ctx.organizationId);
    await deposits.lockSource(request.depositId); await authorizeExternalRefundSourceView(ctx, tx, request);
    const observation = request.identity?.observations[0], settlement = providerRefundSettlementSchema.safeParse(observation?.settlement?.settlement);
    if (observation?.state !== "COMPLETED" || !observation.refundedAt || !settlement.success || !Money.of(settlement.data.fee.amount, settlement.data.fee.currency).amount.gt(0) ||
      await refunds.cancellation(request.id) || await deposits.byCommand(request.idempotencyKey)) throw new ExternalPaymentRefundError();
    const fees = new ExternalPaymentRefundFeeRepository(tx, ctx.organizationId), previous = await fees.byRefund(request.id);
    if (previous) {
      if (previous.createdBy !== ctx.actorId || previous.returnedFee.toFixed(2) !== settlement.data.fee.amount || previous.currency !== request.currency) throw new ExternalPaymentRefundError();
      await authorizeExternalRefundFee(ctx, tx, request, previous.originalExpenseId, Money.of(previous.remainingCost.toString(), previous.currency), previous.correctionExpenseId ?? undefined);
      return { id: previous.id, expenseId: previous.correctionExpenseId, state: previous.correctionExpense?.state ?? previous.originalExpense.state, idempotent: true };
    }
    const { source, head } = await currentCostSource(fees, request.captureId);
    if (source.capture.currency !== request.currency) throw new ExternalPaymentRefundError();
    const target = providerRefundFeeCorrectionTarget({ originalFee: Money.of(source.expense.amount.toString(), source.expense.currency), currentCost: Money.of(head.amount.toString(), head.currency),
      gross: Money.of(request.amount.toString(), request.currency), returnedFee: Money.of(settlement.data.fee.amount, settlement.data.fee.currency), merchantDebit: Money.of(settlement.data.net.amount, settlement.data.net.currency) });
    await authorizeExternalRefundFee(ctx, tx, request, head.id, target.remainingCost);
    const correction = target.remainingCost.amount.gt(0) ? await createExpenseCorrectionDraft(ctx, { id: head.id, expectedVersion: head.version, amount: target.remainingCost.toJSON().amount,
      idempotencyKey: request.id, reason: saved.input.refund.reason }, { db: nativeTransaction(tx), requestId: deps.requestId }) : null;
    if (correction?.idempotent) throw new ExternalPaymentRefundError();
    const binding = await fees.create({ refundIntentId: request.id, captureId: request.captureId, originalExpenseId: head.id, correctionExpenseId: correction?.id ?? null,
      originalExpenseVersion: head.version, currentCost: head.amount.toString(), returnedFee: target.returnedFee.toJSON().amount, remainingCost: target.remainingCost.toJSON().amount,
      currency: request.currency, propertyTimezone: source.propertyTimezone, createdBy: ctx.actorId });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_fee_prepared", resourceType: "financial_transaction", resourceId: request.id,
      after: { intentId: request.id, bindingId: binding.id, captureId: request.captureId, originalExpenseId: head.id, originalExpenseVersion: head.version, correctionExpenseId: correction?.id ?? null,
        currentCost: Money.of(head.amount.toString(), head.currency).toJSON(), returnedFee: target.returnedFee.toJSON(), remainingCost: target.remainingCost.toJSON(), propertyTimezone: source.propertyTimezone },
      reason: saved.input.refund.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: (await new ExpenseRepository(tx, ctx.organizationId).clock()).now });
    await authorizeExternalRefundSourceView(ctx, tx, request);
    await authorizeExternalRefundFee(ctx, tx, request, head.id, target.remainingCost, correction?.id);
    await refunds.flushGuards();
    return { id: binding.id, expenseId: binding.correctionExpenseId, state: "DRAFT" as const, idempotent: false };
  });
}
