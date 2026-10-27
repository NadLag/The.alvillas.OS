import { z } from "zod";
import { authorize, type Action } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { accountingMonthSchema, accountingPeriodState, closeAccountingPeriodSchema, reopenAccountingPeriodSchema,
  AccountingPeriodAccessError, AccountingPeriodConflictError, AccountingPeriodPolicyError } from "../domain/accounting-period";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
async function access(ctx: FinanceActorContext, tx: TenantTransaction, mode: "view" | "close" | "reopen") {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new AccountingPeriodAccessError();
  const now = await new FinanceRepository(tx, ctx.organizationId).clock(), current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
  const actions: Action[] = mode === "view" ? ["view"] : mode === "close" ? ["view", "configure"] : ["view", "configure", "override"];
  const target = { type: "financial_transaction" as const, organizationId: ctx.organizationId, dataClass: "financial" as const };
  for (const authority of [ctx.authContext, current]) for (const action of actions) if (!authorize(authority, action, target, now)) throw new AccountingPeriodAccessError();
  return { now, repository: new AccountingPeriodRepository(tx, ctx.organizationId),
    canClose: authorize(current, "configure", target, now) && authorize(ctx.authContext, "configure", target, now),
    canReopen: [ctx.authContext, current].every(authority => authorize(authority, "configure", target, now) && authorize(authority, "override", target, now)) };
}
const page = <T,>(rows: T[]) => ({ rows: rows.slice(0, 50), more: rows.length > 50 });
export async function assertAccountingPeriodViewer(ctx: FinanceActorContext, deps: Deps = {}) {
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => { await access(ctx, tx, "view"); });
}
export async function listAccountingPeriods(ctx: FinanceActorContext, raw: unknown = {}, deps: Deps = {}) {
  const input = z.object({ after: accountingMonthSchema.optional() }).strict().parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const { repository, now, canClose, canReopen } = await access(ctx, tx, "view"), rows = await repository.list(input.after);
    const policy = await repository.policy(now);
    return { ...page(rows), now, canClose, canReopen, policy,
      states: Object.fromEntries(rows.map(row => [row.id, accountingPeriodState(row.events[0], now)])),
      next: rows.length > 50 ? rows[49].month.toISOString().slice(0, 7) : undefined };
  });
}
export async function getAccountingPeriod(ctx: FinanceActorContext, rawId: string, after: number | undefined = undefined, deps: Deps = {}) {
  const id = z.uuid().parse(rawId); if (after !== undefined) z.number().int().positive().parse(after);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const { repository, now, canClose, canReopen } = await access(ctx, tx, "view"), period = await repository.period(id);
    if (!period) throw new AccountingPeriodAccessError();
    const [events, latest, snapshot, policy] = await Promise.all([repository.history(id, after), repository.latest(id),
      repository.snapshot(period.startsAt, period.endsAt), repository.policy(now)]);
    return { period, ...page(events), latest, state: accountingPeriodState(latest ?? undefined, now), now, canClose, canReopen, snapshot, policy,
      next: events.length > 50 ? events[49].version : undefined };
  });
}

async function recordEvent(ctx: FinanceActorContext, repository: AccountingPeriodRepository, tx: TenantTransaction,
  input: Parameters<AccountingPeriodRepository["createEvent"]>[0], deps: Deps) {
  const event = await repository.createEvent(input);
  const deadline = event.reopensUntil ? await repository.auditDeadline(event.id) : null;
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId,
    action: event.kind === "CLOSE" ? "finance.period.closed" : "finance.period.reopened", resourceType: "accounting_period", resourceId: event.periodId,
    after: { eventId: event.id, version: event.version, kind: event.kind, reopensUntil: deadline,
      durationSeconds: event.reopenSeconds, policyRuleId: event.policyRuleId, snapshot: input.snapshot }, reason: event.reason,
    requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: event.createdAt });
  return { id: event.periodId, version: event.version, eventId: event.id, idempotent: false };
}
function balanced(snapshot: Awaited<ReturnType<AccountingPeriodRepository["snapshot"]>>) {
  if (snapshot.unsealed || snapshot.currencies.some(row => !Money.of(row.debit, row.currency).amount.eq(Money.of(row.credit, row.currency).amount))) throw new AccountingPeriodPolicyError("unbalanced");
}
export async function closeAccountingPeriod(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = closeAccountingPeriodSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new AccountingPeriodRepository(tx, ctx.organizationId); await repository.lock();
    const { now } = await access(ctx, tx, "close"), existing = await repository.eventByKey(input.idempotencyKey);
    if (existing) {
      if (existing.kind !== "CLOSE" || existing.period.month.toISOString().slice(0, 7) !== input.month || existing.reason !== input.reason ||
        existing.createdBy !== ctx.actorId || existing.version !== input.expectedVersion + 1) throw new AccountingPeriodConflictError();
      return { id: existing.periodId, version: existing.version, eventId: existing.id, idempotent: true };
    }
    const policy = await repository.policy(now); if (!policy) throw new AccountingPeriodPolicyError();
    let period = await repository.byMonth(input.month);
    if (!period) {
      if (input.expectedVersion !== 0) throw new AccountingPeriodConflictError();
      period = await repository.createPeriod({ month: input.month, timezone: policy.value.timezone,
        ...await repository.bounds(input.month, policy.value.timezone), policyRuleId: policy.id, createdBy: ctx.actorId });
    }
    const previous = await repository.latest(period.id);
    if ((previous?.version ?? 0) !== input.expectedVersion || previous?.kind === "CLOSE") throw new AccountingPeriodConflictError();
    if (period.endsAt > now && !policy.value.allow_early_close) throw new AccountingPeriodPolicyError("earlyClose");
    const snapshot = await repository.snapshot(period.startsAt, period.endsAt); balanced(snapshot);
    return recordEvent(ctx, repository, tx, { periodId: period.id, version: input.expectedVersion + 1, kind: "CLOSE", reason: input.reason,
      idempotencyKey: input.idempotencyKey, previousEventId: previous?.id ?? null, reopenSeconds: null, policyRuleId: policy.id, snapshot, createdBy: ctx.actorId }, deps);
  });
}
export async function reopenAccountingPeriod(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = reopenAccountingPeriodSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new AccountingPeriodRepository(tx, ctx.organizationId); await repository.lock();
    const { now } = await access(ctx, tx, "reopen"), existing = await repository.eventByKey(input.idempotencyKey);
    if (existing) {
      if (existing.kind !== "REOPEN" || existing.periodId !== input.periodId || existing.reason !== input.reason || existing.createdBy !== ctx.actorId ||
        existing.version !== input.expectedVersion + 1 || existing.reopenSeconds !== input.durationSeconds) throw new AccountingPeriodConflictError();
      return { id: existing.periodId, version: existing.version, eventId: existing.id, idempotent: true };
    }
    const period = await repository.period(input.periodId); if (!period) throw new AccountingPeriodAccessError();
    const previous = await repository.latest(period.id);
    if (!previous || previous.version !== input.expectedVersion || accountingPeriodState(previous, now) !== "CLOSED") throw new AccountingPeriodConflictError();
    const policy = await repository.policy(now); if (!policy) throw new AccountingPeriodPolicyError();
    if (input.durationSeconds > policy.value.max_reopen_seconds) throw new AccountingPeriodPolicyError("invalidWindow");
    const snapshot = await repository.snapshot(period.startsAt, period.endsAt); balanced(snapshot);
    return recordEvent(ctx, repository, tx, { periodId: period.id, version: input.expectedVersion + 1, kind: "REOPEN", reason: input.reason,
      idempotencyKey: input.idempotencyKey, previousEventId: previous.id, reopenSeconds: input.durationSeconds, policyRuleId: policy.id, snapshot, createdBy: ctx.actorId }, deps);
  });
}
