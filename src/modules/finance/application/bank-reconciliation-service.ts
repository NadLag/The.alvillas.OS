import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicyKey, bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";
import { Money } from "@/platform/money/money";
import { bankStatementBankIdentity } from "../domain/bank-statement-import";
import { bankStatementSourceStates, bankStatementSourceFamilyMembers } from "../domain/bank-statement-source-state";
import { bankStatementFactSchema } from "../domain/bank-statement";
import { bankStatementMatchSuggestions } from "../domain/bank-statement-matching";
import { bankReconciliationWorkspaceInput, bankReconciliationSourcesSchema, bankReconciliationPostingsSchema, bankReconciliationHistorySchema } from "../domain/bank-reconciliation-workspace";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { calendarDateAt } from "@/i18n/format";
import { authorize } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import { bankReconciliationReviewInput, bankReconciliationMatchInput, bankReconciliationReleaseInput, bankReconciliationRecoveryInput,
  BankReconciliationAccessError, BankReconciliationConfigurationError, BankReconciliationConflictError, BankReconciliationMissingError } from "../domain/bank-reconciliation";
import { reconciliationPlan, ReconciliationBudgetError } from "../domain/reconciliation";
import { moneyReconciliationMeasure } from "../domain/reconciliation-money";
import { BankReconciliationRepository } from "../infrastructure/bank-reconciliation-repository";
import { BankStatementRepository } from "../infrastructure/bank-statement-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Check = Parameters<typeof recheckFinanceAuthorization>[3][number];
const capture = (ctx: FinanceActorContext) => ({ ...ctx, authContext: restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext)) });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const checks = (organizationId: string, accountId: string, write: boolean): Check[] => {
  const resource = { type: "bank_statement", organizationId, id: accountId, financialRecordId: accountId, dataClass: "financial" as const };
  return [{ action: "view", resource, unconditional: true }, { action: "view", resource: { ...resource, type: "financial_transaction" }, unconditional: true },
    ...(write ? [{ action: "reconcile" as const, resource, unconditional: true }] : [])];
};
async function authority(ctx: FinanceActorContext, tx: TenantTransaction, accountId: string, write: boolean, extra: Check[] = []) {
  await recheckFinanceAuthorization(ctx, tx, await new FinanceRepository(tx, ctx.organizationId).clock(), [...checks(ctx.organizationId, accountId, write), ...extra], new BankReconciliationAccessError());
}
function visible(ctx: FinanceActorContext, accountId: string, value: Record<string, unknown>) {
  return present({ ...ctx.authContext, visibleDataClasses: new Set(["financial"] as const) }, "view",
    { type: "bank_statement", organizationId: ctx.organizationId, id: accountId, financialRecordId: accountId, dataClass: "financial", data: value }, catalogFieldPolicy("bank_statement"));
}
async function prepare(ctx: FinanceActorContext, raw: unknown, tx: TenantTransaction, write: boolean) {
  const input = bankReconciliationReviewInput.parse(raw);
  await authority(ctx, tx, input.accountId, write);
  const repository = new BankReconciliationRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
  const account = await new BankStatementRepository(tx, ctx.organizationId).account(input.accountId), now = await finance.clock();
  if (!account || account.archivedAt || account.teamWallet || account.accountType !== "ASSET_LOCATION" || account.normalSide !== "DEBIT") throw new BankReconciliationConfigurationError();
  const resolved = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: bankStatementPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
  if (!resolved) throw new BankReconciliationConfigurationError();
  const rule = bankStatementPolicySchema.parse(resolved.value), binding = rule.accounts.find(binding => binding.account_code === account.code);
  const currency = await new FinancialTransferRepository(tx, ctx.organizationId).currency(input.currency);
  if (!binding || binding.currency !== input.currency || !currency || currency.minorUnit > 2) throw new BankReconciliationConfigurationError();
  const policy = { id: resolved.id, version: resolved.version, matching: rule.matching, bankIdentityHash: bankStatementBankIdentity(binding) };
  const sourceIds = [...input.actual.map(row => row.id), ...(input.evidence ?? [])];
  const [postings, selectedLines, families] = await Promise.all([repository.postings(account.id, input.expected.map(row => row.id)), repository.lines(account.id, sourceIds), repository.families(sourceIds)]);
  const lines = selectedLines.filter(row => input.actual.some(selected => selected.id === row.id)), removals = selectedLines.filter(row => input.evidence?.includes(row.id));
  const budgets = await repository.allocated(input.expected.map(row => row.id), families.map(row => row.id)), familyMembers = bankStatementSourceFamilyMembers(families);
  const activeEvidence = await repository.activeEvidence(families.map(row => row.id));
  const states = bankStatementSourceStates(families);
  if (postings.length !== input.expected.length || lines.length !== input.actual.length || postings.some(row => row.currency !== input.currency || !["DEBIT", "CREDIT"].includes(row.side)) ||
      lines.some(row => row.currency !== input.currency || row.bankIdentityHash !== policy.bankIdentityHash || states.get(row.id) !== "ACTIVE" || !row.amount) ||
      removals.length !== (input.evidence?.length ?? 0) || removals.some(row => row.currency !== input.currency || row.bankIdentityHash !== policy.bankIdentityHash || row.correctionAction !== "DELETE" || states.get(row.id) !== "REMOVED")) throw new BankReconciliationConflictError();
  if (selectedLines.some(row => familyMembers.get(row.id)!.some(id => activeEvidence.has(id) || (id !== row.id || row.correctionAction === "DELETE") && Money.of(budgets.get("ACTUAL:" + id) ?? "0.00", row.currency).amount.gt(0)))) throw new ReconciliationBudgetError();
  const expectedAmounts = new Map(input.expected.map(row => [row.id, row.amount])), actualAmounts = new Map(input.actual.map(row => [row.id, row.amount]));
  const extra: Check[] = [];
  const exposure = new Map<string, Money>();
  for (const row of postings) exposure.set(row.transactionId, (exposure.get(row.transactionId) ?? Money.zero(input.currency)).add(Money.of(row.amount.toString(), input.currency)));
  for (const [id, amount] of exposure) {
    const resource = { type: "financial_transaction", organizationId: ctx.organizationId, id, financialRecordId: id, dataClass: "financial" as const, amount: amount.toJSON().amount,
      occurredAt: postings.find(row => row.transactionId === id)!.transaction.occurredAt };
    extra.push({ action: "view", resource }, ...(write ? [{ action: "reconcile" as const, resource }] : []));
  }
  await authority(ctx, tx, account.id, write, extra);
  const plan = reconciliationPlan(moneyReconciliationMeasure(input.currency, currency.minorUnit), {
    expected: postings.map(row => ({ sourceKey: row.id, original: Money.of((row.side === "CREDIT" ? "-" : "") + row.amount.toFixed(2), input.currency),
      allocatedBefore: Money.of(budgets.get("EXPECTED:" + row.id) ?? "0.00", input.currency), amount: Money.of(expectedAmounts.get(row.id)!, input.currency) })),
    actual: lines.map(row => ({ sourceKey: row.id, original: Money.of(row.amount!.toFixed(2), input.currency),
      allocatedBefore: Money.of(budgets.get("ACTUAL:" + row.id) ?? "0.00", input.currency), amount: Money.of(actualAmounts.get(row.id)!, input.currency) })),
    evidence: removals.map(row => ({ side: "ACTUAL" as const, sourceKey: row.id, fingerprint: row.factHash })), tolerance: Money.of(policy.matching.amount_tolerance, input.currency), reason: input.reason, varianceAction: input.varianceAction
  });
  const witnesses = {
    expected: postings.map(row => ({ id: row.id, transactionId: row.transactionId, reference: row.transaction.reference, side: row.side, amount: row.amount.toFixed(2), currency: row.currency,
      reversalIds: row.transaction.reversedByTransactions.map(reversal => reversal.id) })),
    actual: lines.map(row => ({ id: row.id, factHash: row.factHash, bankIdentityHash: row.bankIdentityHash })),
    ...(removals.length ? { evidence: removals.map(row => ({ id: row.id, factHash: row.factHash, bankIdentityHash: row.bankIdentityHash })) } : {})
  };
  return { input, repository, account, policy, plan, witnesses, extra, reviewFingerprint: commandFingerprint({ input, policy, plan, witnesses }) };
}
export async function reviewBankReconciliation(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = capture(context);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const prepared = await prepare(ctx, raw, tx, false);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_reconciliation.reviewed", resourceType: "bank_statement", resourceId: prepared.account.id,
      after: { reviewFingerprint: prepared.reviewFingerprint, plan: prepared.plan }, reason: prepared.input.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await authority(ctx, tx, prepared.account.id, false, prepared.extra);
    return visible(ctx, prepared.account.id, { reviewFingerprint: prepared.reviewFingerprint, plan: prepared.plan });
  });
}
async function retained(ctx: FinanceActorContext, row: NonNullable<Awaited<ReturnType<BankReconciliationRepository["entry"]>>>, tx: TenantTransaction) {
  const repository = new BankReconciliationRepository(tx, ctx.organizationId);
  const source = row.action === "RELEASE" && row.previousEntryId ? await repository.entry(row.previousEntryId) : row;
  if (!source) throw new BankReconciliationAccessError();
  const postings = await repository.postings(row.ledgerAccountId, source.allocations.flatMap(allocation => allocation.postingId ? [allocation.postingId] : []));
  const exposure = new Map<string, Money>();
  for (const posting of postings) exposure.set(posting.transactionId, (exposure.get(posting.transactionId) ?? Money.zero(row.currency)).add(Money.of(posting.amount.toFixed(2), row.currency)));
  const extra: Check[] = [...exposure].map(([id, amount]) => ({ action: "view", resource: { type: "financial_transaction", organizationId: ctx.organizationId, id,
    financialRecordId: id, dataClass: "financial", amount: amount.toJSON().amount, occurredAt: postings.find(posting => posting.transactionId === id)!.transaction.occurredAt } }));
  await authority(ctx, tx, row.ledgerAccountId, false, extra);
  const families = bankStatementSourceStates(await repository.families([...source.allocations.flatMap(allocation => allocation.lineId ? [allocation.lineId] : []), ...source.evidence.map(witness => witness.lineId)]));
  const changed = source.allocations.some(allocation => allocation.lineId ? families.get(allocation.lineId) !== "ACTIVE" :
    commandFingerprint(z.object({ reversalIds: z.array(z.uuid()) }).parse(allocation.sourceSnapshot).reversalIds) !==
      commandFingerprint(postings.find(posting => posting.id === allocation.postingId)?.transaction.reversedByTransactions.map(reversal => reversal.id))) || source.evidence.some(witness => families.get(witness.lineId) !== "REMOVED");
  const variance = z.object({ variance: z.string() }).parse(source.snapshot).variance;
  const state = row.action === "RELEASE" || row.release ? "RELEASED" : changed ? "SOURCE_CHANGED" : variance === "0.00" ? "MATCHED" : "OPEN_VARIANCE";
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_reconciliation.read", resourceType: "bank_statement", resourceId: row.id,
    after: { id: row.id, accountId: row.ledgerAccountId, state }, reason: "Read original retained bank reconciliation with current source authority", requestId: randomUUID(),
    occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
  await authority(ctx, tx, row.ledgerAccountId, false, extra);
  return { extra, value: visible(ctx, row.ledgerAccountId, { id: row.id, accountId: row.ledgerAccountId, action: row.action, state,
    ...(row.action === "RELEASE" ? { originalId: row.previousEntryId } : { releasedById: row.release?.id ?? null }), plan: row.snapshot }) };
}
/** Shared retained-source authority for variance metadata; no allocation or journal is changed. */
export async function inspectBankVarianceSource(context: FinanceActorContext, entryId: string, tx: TenantTransaction,
  access: "view" | "history" | "ASSIGN" | "RESOLVE" | "REOPEN") {
  const ctx = capture(context), row = await new BankReconciliationRepository(tx, ctx.organizationId).entry(entryId);
  if (!row || row.action !== "MATCH") throw new BankReconciliationMissingError();
  const original = await retained(ctx, row, tx), write = access !== "view" && access !== "history";
  const extra: Check[] = [...original.extra, ...(write ? original.extra.map(check => ({ ...check, action: "reconcile" as const })) : [])];
  if (access === "ASSIGN") extra.push({ action: "assign", resource: { type: "bank_statement", organizationId: ctx.organizationId,
    id: row.ledgerAccountId, financialRecordId: row.ledgerAccountId, dataClass: "financial" }, unconditional: true });
  if (access === "history") extra.push(...original.extra.map(check => ({ ...check, resource: { ...check.resource, type: "audit_log" } })));
  const recheck = () => authority(ctx, tx, row.ledgerAccountId, write, extra);
  await recheck(); return { row, recheck };
}
export async function matchBankStatement(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = capture(context), input = bankReconciliationMatchInput.parse(raw), commandHash = commandFingerprint(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const locks = new FinancialTransferRepository(tx, ctx.organizationId), repository = new BankReconciliationRepository(tx, ctx.organizationId);
    await locks.lock(`bank-reconciliation-command:${ctx.actorId}:${input.idempotencyKey}`);
    const existing = await repository.request(ctx.actorId, input.idempotencyKey);
    if (existing) { if (existing.commandHash !== commandHash) throw new BankReconciliationConflictError(); return (await retained(ctx, existing, tx)).value; }
    await authority(ctx, tx, input.accountId, true);
    // The account lock serializes allocation budgets across every historical bank identity.
    await locks.lock(`bank-reconciliation-account:${input.accountId}`);
    const lines = await repository.lines(input.accountId, [...input.actual.map(row => row.id), ...(input.evidence ?? [])]);
    for (const identity of [...new Set(lines.map(row => row.bankIdentityHash))].sort()) await locks.lock(`bank-statement-source:${identity}`);
    await new ConfigRuleRepository(tx, ctx.organizationId).lockVersion(bankStatementPolicyKey, "organization", null);
    const { idempotencyKey, reviewFingerprint, ...review } = input; void idempotencyKey;
    const prepared = await prepare(ctx, review, tx, true);
    if (prepared.reviewFingerprint !== reviewFingerprint) throw new BankReconciliationConflictError();
    const row = await repository.create({ actorId: ctx.actorId, ledgerAccountId: input.accountId, currency: input.currency, action: "MATCH", idempotencyKey: input.idempotencyKey,
      commandHash, input: json(input), policySnapshot: json(prepared.policy), snapshot: json(prepared.plan), reason: input.reason });
    await repository.allocate(row.id, (["expected", "actual"] as const).flatMap(side => prepared.plan.allocations[side].map(allocation => ({
      postingId: side === "expected" ? allocation.sourceKey : null, lineId: side === "actual" ? allocation.sourceKey : null,
      originalAmount: allocation.original, allocatedBefore: allocation.allocatedBefore, amount: allocation.amount, currency: input.currency,
      sourceSnapshot: json(prepared.witnesses[side].find(witness => witness.id === allocation.sourceKey)!)
    }))));
    if (prepared.witnesses.evidence) await repository.retainEvidence(row.id, prepared.witnesses.evidence.map(witness => ({ lineId: witness.id, sourceSnapshot: json(witness) })));
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_reconciliation.matched", resourceType: "bank_statement", resourceId: row.id,
      after: { id: row.id, accountId: input.accountId, commandHash, plan: prepared.plan }, reason: input.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await repository.flush(); await authority(ctx, tx, input.accountId, true, prepared.extra);
    return visible(ctx, input.accountId, { id: row.id, accountId: input.accountId, action: row.action, state: prepared.plan.variance === "0.00" ? "MATCHED" : "OPEN_VARIANCE", releasedById: null, plan: prepared.plan });
  });
}
export async function recoverBankReconciliation(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = capture(context), input = bankReconciliationRecoveryInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    await new FinancialTransferRepository(tx, ctx.organizationId).lock(`bank-reconciliation-command:${ctx.actorId}:${input.idempotencyKey}`);
    const row = await new BankReconciliationRepository(tx, ctx.organizationId).request(ctx.actorId, input.idempotencyKey);
    if (!row) throw new BankReconciliationMissingError();
    return (await retained(ctx, row, tx)).value;
  });
}
export async function releaseBankReconciliation(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = capture(context), input = bankReconciliationReleaseInput.parse(raw), commandHash = commandFingerprint(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new BankReconciliationRepository(tx, ctx.organizationId), locks = new FinancialTransferRepository(tx, ctx.organizationId);
    await locks.lock(`bank-reconciliation-command:${ctx.actorId}:${input.idempotencyKey}`);
    const existing = await repository.request(ctx.actorId, input.idempotencyKey);
    if (existing) { if (existing.commandHash !== commandHash) throw new BankReconciliationConflictError(); return (await retained(ctx, existing, tx)).value; }
    const original = await repository.entry(input.id);
    if (!original || original.action !== "MATCH") throw new BankReconciliationAccessError();
    await authority(ctx, tx, original.ledgerAccountId, true);
    await locks.lock(`bank-reconciliation-account:${original.ledgerAccountId}`);
    const current = await repository.entry(original.id);
    if (!current || current.release) throw new BankReconciliationConflictError();
    const read = await retained(ctx, current, tx), extra = read.extra.flatMap(check => [check, { ...check, action: "reconcile" as const }]);
    await authority(ctx, tx, current.ledgerAccountId, true, extra);
    const row = await repository.create({ actorId: ctx.actorId, ledgerAccountId: current.ledgerAccountId, currency: current.currency, action: "RELEASE", previousEntryId: current.id,
      idempotencyKey: input.idempotencyKey, commandHash, input: json(input), policySnapshot: current.policySnapshot as Prisma.InputJsonValue, snapshot: current.snapshot as Prisma.InputJsonValue, reason: input.reason });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_reconciliation.released", resourceType: "bank_statement", resourceId: row.id,
      after: { id: row.id, originalId: current.id, accountId: current.ledgerAccountId, commandHash }, reason: input.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await repository.flush(); await authority(ctx, tx, current.ledgerAccountId, true, extra);
    return visible(ctx, current.ledgerAccountId, { id: row.id, accountId: current.ledgerAccountId, action: row.action, state: "RELEASED", originalId: current.id, plan: current.snapshot });
  });
}

export async function readBankReconciliationWorkspace(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = capture(context), input = bankReconciliationWorkspaceInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new BankReconciliationRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
    if (input.operation === "DETAIL") {
      const row = await repository.entry(input.id);
      if (!row) throw new BankReconciliationAccessError();
      const read = await retained(ctx, row, tx), now = await finance.clock(), current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
      const canRelease = row.action === "MATCH" && !row.release && [ctx.authContext, current].every(auth =>
        authorizeUnconditionalSource(auth, "reconcile", { type: "bank_statement", organizationId: ctx.organizationId, id: row.ledgerAccountId, financialRecordId: row.ledgerAccountId, dataClass: "financial" }, now)
        && read.extra.every(check => authorize(auth, "reconcile", check.resource, now)));
      await authority(ctx, tx, row.ledgerAccountId, false, read.extra);
      return { ...read.value, canRelease };
    }
    await authority(ctx, tx, input.accountId, false);
    const now = await finance.clock(), current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
    const allows = (action: "view" | "reconcile", row: Awaited<ReturnType<BankReconciliationRepository["postings"]>>[number]) => {
      const resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: row.transactionId, financialRecordId: row.transactionId,
        dataClass: "financial" as const, amount: row.amount.toFixed(2), occurredAt: row.transaction.occurredAt };
      return [ctx.authContext, current].every(auth => authorize(auth, action, resource, now));
    };
    const extra: Check[] = [];
    const requirePostings = (rows: Awaited<ReturnType<BankReconciliationRepository["postings"]>>) => {
      const exposure = new Map<string, { id: string; amount: Money; occurredAt: Date }>();
      for (const row of rows) {
        const key = row.transactionId + ":" + row.currency;
        exposure.set(key, { id: row.transactionId, amount: (exposure.get(key)?.amount ?? Money.zero(row.currency)).add(Money.of(row.amount.toFixed(2), row.currency)), occurredAt: row.transaction.occurredAt });
      }
      for (const { id, amount, occurredAt } of exposure.values()) extra.push({ action: "view", resource: { type: "financial_transaction", organizationId: ctx.organizationId, id, financialRecordId: id,
        dataClass: "financial", amount: amount.toJSON().amount, occurredAt } });
    };
    const disclose = async (value: Record<string, unknown>) => {
      await authority(ctx, tx, input.accountId, false, extra);
      await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_reconciliation.workspace_read", resourceType: "bank_statement", resourceId: input.accountId,
        after: { operation: input.operation }, reason: "Read independently authorized original bank reconciliation sources and history", requestId: deps.requestId ?? randomUUID(), occurredAt: await finance.clock() });
      await authority(ctx, tx, input.accountId, false, extra);
      return visible(ctx, input.accountId, value);
    };
    if (input.operation === "HISTORY") {
      const batch = await repository.history(input.accountId, input.before), rows = batch.slice(0, 50);
      const ids = [...new Set(rows.flatMap(row => (row.action === "RELEASE" ? row.previous?.allocations ?? [] : row.allocations).flatMap(allocation => allocation.postingId ? [allocation.postingId] : [])))];
      const postings = await repository.postings(input.accountId, ids), byPosting = new Map(postings.map(posting => [posting.id, posting]));
      const permitted = rows.filter(row => (row.action === "RELEASE" ? row.previous?.allocations ?? [] : row.allocations)
        .every(allocation => !allocation.postingId || byPosting.has(allocation.postingId) && allows("view", byPosting.get(allocation.postingId)!)));
      const heldIds = new Set(permitted.flatMap(row => (row.action === "RELEASE" ? row.previous?.allocations ?? [] : row.allocations).flatMap(allocation => allocation.postingId ? [allocation.postingId] : [])));
      requirePostings(postings.filter(posting => heldIds.has(posting.id)));
      const states = await repository.states(permitted.map(row => row.id));
      return disclose(bankReconciliationHistorySchema.parse({ items: permitted.map(row => ({ id: row.id, action: row.action, previousId: row.previousEntryId,
        createdAt: row.createdAt.toISOString(), currency: row.currency, reason: row.reason, plan: row.snapshot, state: states.get(row.id) })), next: batch.length > 50 ? rows.at(-1)!.id : null }));
    }
    const resolved = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: bankStatementPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
    const policy = resolved ? bankStatementPolicySchema.parse(resolved.value) : null, account = await new BankStatementRepository(tx, ctx.organizationId).account(input.accountId);
    if (!account || account.accountType !== "ASSET_LOCATION" || account.normalSide !== "DEBIT" || account.teamWallet) throw new BankReconciliationAccessError();
    const binding = policy?.accounts.find(binding => binding.account_code === account.code && binding.currency === input.currency);
    if (!binding && !await repository.knownBankAccount(input.accountId)) throw new BankReconciliationAccessError();
    if (input.operation === "SOURCES") {
      const batch = await repository.sourcePage(input.accountId, input.currency, input.after), rows = batch.slice(0, 50);
      const facts = await repository.families(rows.map(row => row.id)), budgets = await repository.allocated([], facts.map(row => row.id));
      const activeEvidence = await repository.activeEvidence(facts.map(row => row.id));
      const states = bankStatementSourceStates(facts), familyMembers = bankStatementSourceFamilyMembers(facts);
      const canReconcile = [ctx.authContext, current].every(auth => authorizeUnconditionalSource(auth, "reconcile", { type: "bank_statement", organizationId: ctx.organizationId,
        id: input.accountId, financialRecordId: input.accountId, dataClass: "financial" }, now));
      return disclose(bankReconciliationSourcesSchema.parse({ canReconcile, items: rows.map(row => {
        const magnitude = Money.of(row.amount?.abs().toFixed(2) ?? "0.00", row.currency), allocated = Money.of(budgets.get("ACTUAL:" + row.id) ?? "0.00", row.currency), remaining = magnitude.subtract(allocated);
        return { id: row.id, fact: bankStatementFactSchema.parse(row.source), state: states.get(row.id), allocated: allocated.toJSON(), remaining: remaining.toJSON(),
          eligible: !!binding && !account.archivedAt && row.bankIdentityHash === bankStatementBankIdentity(binding)
            && (states.get(row.id) === "ACTIVE" && remaining.amount.gt(0) || states.get(row.id) === "REMOVED" && row.correctionAction === "DELETE")
            && !familyMembers.get(row.id)!.some(id => activeEvidence.has(id) || (id !== row.id || row.correctionAction === "DELETE") && Money.of(budgets.get("ACTUAL:" + id) ?? "0.00", row.currency).amount.gt(0)) };
      }), next: batch.length > 50 ? rows.at(-1)!.id : null }));
    }
    const batch = await repository.postingPage(input.accountId, input.currency, input.after), rows = batch.slice(0, 50).filter(row => allows("view", row));
    requirePostings(rows);
    const source = input.lineId ? (await repository.lines(input.accountId, [input.lineId]))[0] : null;
    if (input.lineId && (!source || source.currency !== input.currency)) throw new BankReconciliationAccessError();
    const budgets = await repository.allocated(rows.map(row => row.id), source ? [source.id] : []), calendar = await new AccountingPeriodRepository(tx, ctx.organizationId).policy(now);
    const remaining = (row: typeof rows[number]) => Money.of(row.amount.toFixed(2), row.currency).subtract(Money.of(budgets.get("EXPECTED:" + row.id) ?? "0.00", row.currency));
    const sourceAmount = source?.amount ? Money.of(source.amount.abs().toFixed(2), source.currency).subtract(Money.of(budgets.get("ACTUAL:" + source.id) ?? "0.00", source.currency)) : null;
    const sourceState = source ? bankStatementSourceStates(await repository.families([source.id])).get(source.id) : null;
    const suggestions = source && sourceAmount?.amount.gt(0) && source.postedOn && sourceState === "ACTIVE" && calendar && policy && binding && source.bankIdentityHash === bankStatementBankIdentity(binding)
      ? bankStatementMatchSuggestions({ accountId: input.accountId, postedDate: source.postedOn.toISOString().slice(0, 10), amount: (source.amount!.isNegative() ? Money.zero(source.currency).subtract(sourceAmount) : sourceAmount).toJSON(), reference: bankStatementFactSchema.parse(source.source).reference },
        rows.filter(row => remaining(row).amount.gt(0)).map(row => ({ postingId: row.id, transactionId: row.transactionId, accountId: input.accountId,
          postedDate: calendarDateAt(row.transaction.occurredAt, calendar.value.timezone), amount: (row.side === "CREDIT" ? Money.zero(row.currency).subtract(remaining(row)) : remaining(row)).toJSON(), reference: row.transaction.reference })), policy.matching)
      : [];
    const suggested = new Set(suggestions.map(row => row.postingId));
    return disclose(bankReconciliationPostingsSchema.parse({ items: rows.map(row => ({ id: row.id, transactionId: row.transactionId, reference: row.transaction.reference, occurredAt: row.transaction.occurredAt.toISOString(),
      original: (row.side === "CREDIT" ? Money.zero(row.currency).subtract(Money.of(row.amount.toFixed(2), row.currency)) : Money.of(row.amount.toFixed(2), row.currency)).toJSON(),
      allocated: Money.of(budgets.get("EXPECTED:" + row.id) ?? "0.00", row.currency).toJSON(), remaining: remaining(row).toJSON(), suggested: suggested.has(row.id), canReconcile: allows("reconcile", row) })),
      next: batch.length > 50 ? batch[49].id : null,
      matching: policy && calendar ? { dateWindowDays: policy.matching.date_window_days, amountTolerance: policy.matching.amount_tolerance, reference: policy.matching.reference, timezone: calendar.value.timezone } : null }));
  });
}
