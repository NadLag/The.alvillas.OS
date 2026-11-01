import { z } from "zod";
import { authorize, type Action, type Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { localClockInstant, localClockDefault } from "@/platform/time/local-instant";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { lockWalletHolders } from "@/platform/ledger/wallet-lock";
import { Money } from "@/platform/money/money";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { SupplierPayableRepository } from "../infrastructure/supplier-payable-repository";
import { expenseFundingWalletResource, isExpenseFundingAccount } from "../domain/expense";
import { supplierInvoiceCostResource } from "../domain/supplier-invoice";
import { supplierPaymentPostings } from "../domain/supplier-payable";
import { supplierPaymentInput, supplierPaymentVoidInput, supplierSettlementQuery, supplierInvoiceReversalInput } from "../domain/supplier-payment";
import { matchesFinancialReversalAttempt } from "../domain/financial-reversal";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { inspectSupplierInvoiceRecognitionSource } from "./supplier-invoice-recognition";
import { assertSupplierInvoiceAuthority, supplierInvoiceOrganizationResource, SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import type { FinanceLedgerAccount } from "../infrastructure/finance-repository";

type Deps = { db?: TenantTransactionRunner; requestId?: string;
  calendar?: { id: string; version: number; local: string; occurrence: "reject" | "earlier" | "later" } };
type Source = Awaited<ReturnType<typeof inspectSupplierInvoiceRecognitionSource>>;
type Check = { action: Action; resource: Resource; organizationOnly?: boolean };
const receipt = z.object({ input: supplierPaymentInput, recognitionId: z.uuid(), transactionId: z.uuid(),
  sourcePeriodId: z.uuid().nullable(), sourcePeriodEventId: z.uuid().nullable(), postedAt: z.iso.datetime() }).strict();

function paymentResource(ctx: FinanceActorContext, source: Source, amount: string, at: Date, id?: string): Resource {
  const properties = new Set(source.costs.map(cost => cost.propertyId));
  const line = properties.size === 1 && source.costs[0].propertyId ? source.revision.lines.find(line => line.id === source.costs[0].id) : null;
  return { type: "financial_transaction", organizationId: ctx.organizationId, id, financialRecordId: id, dataClass: "financial", amount, occurredAt: at,
    ...(line ? { propertyId: line.propertyId, city: line.property?.cityId, region: line.property?.regionId } : {}) };
}
function fundingChecks(ctx: FinanceActorContext, account: FinanceLedgerAccount, amount: string, at: Date, action: "view" | "pay" | "void"): Check[] {
  const target: Resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: account.id, financialRecordId: account.id, dataClass: "financial", amount, occurredAt: at };
  const wallet = expenseFundingWalletResource(ctx.organizationId, account, amount, at);
  return [{ action: "view", resource: target }, { action, resource: target }, ...(wallet ? [{ action: "view" as const, resource: wallet }, { action, resource: wallet }] : [])];
}
async function prepareSettlement(ctx: FinanceActorContext, id: string, tx: TenantTransaction, action: "view" | "pay" | "void") {
  const source = await inspectSupplierInvoiceRecognitionSource(ctx, id, tx), payables = new SupplierPayableRepository(tx, ctx.organizationId);
  if (!source.existing) throw new SupplierInvoiceConflictError();
  const originalCosts = new Map(source.existing.lines.map(link => [link.transactionId, source.costs.find(cost => cost.id === link.invoiceLineId)]));
  const sourceChecks = (verb: "view" | "pay" | "void") => {
    const checks: Check[] = [];
    for (const cost of source.costs) {
      const line = source.revision.lines.find(line => line.id === cost.id)!, link = source.existing!.lines.find(link => link.invoiceLineId === cost.id)!;
      const invoice = supplierInvoiceCostResource(ctx.organizationId, source.row, line, Money.of(source.revision.amount.toString(), source.revision.currency),
        source.source.occurredOn.toISOString().slice(0, 10), cost.timezone, cost.sourceOccurredAt);
      if (verb !== "view") checks.push({ action: verb, resource: invoice, organizationOnly: !line.propertyId },
        { action: verb, resource: { ...invoice, type: "financial_transaction", id: link.transactionId, financialRecordId: link.transactionId, occurredAt: link.transaction.occurredAt }, organizationOnly: !line.propertyId });
    }
    return checks;
  };
  const checkSourceAction = async (verb: "pay" | "void", at: Date) => {
    await assertSupplierInvoiceAuthority(ctx, tx, verb, at);
    await recheckFinanceAuthorization(ctx, tx, at, sourceChecks(verb), new SupplierInvoiceAccessError());
  };
  const recheck = async (at: Date, extra: Check[] = []) => {
    await source.recheck(at);
    await assertSupplierInvoiceAuthority(ctx, tx, action, at);
    const checks: Check[] = [...extra, ...sourceChecks(action)];
    const journals = await payables.movementJournals(id);
    const paymentIds = journals.filter(journal => !journal.reversesTransactionId && journal.postings.some(posting => posting.bucket === "SUPPLIER_PAYMENT")).map(journal => journal.id);
    const receipts = new Map((paymentIds.length ? await payables.paymentAudits(paymentIds) : []).map(audit => [audit.resourceId, receipt.parse(audit.after)]));
    for (const journal of journals) {
      const reversedCost = journal.reversesTransactionId && originalCosts.get(journal.reversesTransactionId);
      if (reversedCost) {
        const line = source.revision.lines.find(line => line.id === reversedCost.id)!;
        const cost = supplierInvoiceCostResource(ctx.organizationId, source.row, line, reversedCost.amount, source.source.occurredOn.toISOString().slice(0, 10), reversedCost.timezone, reversedCost.sourceOccurredAt);
        checks.push({ action: "view", resource: { ...cost, type: "financial_transaction", id: journal.id, financialRecordId: journal.id, occurredAt: journal.occurredAt }, organizationOnly: !line.propertyId });
      }
      const payment = journal.postings.find(posting => posting.bucket === "SUPPLIER_PAYMENT");
      if (!payment) continue;
      const target = paymentResource(ctx, source, payment.amount.toString(), journal.occurredAt, journal.id);
      checks.push({ action: "view", resource: target, organizationOnly: !target.propertyId });
      const saved = receipts.get(journal.reversesTransactionId ?? journal.id); if (!saved) throw new SupplierInvoiceConflictError();
      const paidAt = new Date(saved.input.paidAt);
      checks.push({ action: "view", resource: { ...target, occurredAt: paidAt }, organizationOnly: !target.propertyId });
      for (const posting of journal.postings) if (posting.ledgerAccount.code !== "SUPPLIER_PAYABLE") {
        checks.push(...fundingChecks(ctx, posting.ledgerAccount, payment.amount.toString(), journal.occurredAt, "view"));
        checks.push(...fundingChecks(ctx, posting.ledgerAccount, payment.amount.toString(), paidAt, "view"));
      }
    }
    await recheckFinanceAuthorization(ctx, tx, at, checks, new SupplierInvoiceAccessError());
    return { journals, receipts };
  };
  const observed = await recheck(await source.finance.clock());
  return { ...source, payables, journals: observed.journals, paymentReceipts: observed.receipts, recheckSettlement: recheck, checkSourceAction };
}

function paymentVoidChecks(ctx: FinanceActorContext, source: Source, saved: z.infer<typeof receipt>, original: { id: string; occurredAt: Date }, funding: FinanceLedgerAccount, now: Date): Check[] {
  const paidAt = new Date(saved.input.paidAt), target = paymentResource(ctx, source, saved.input.amount, original.occurredAt, original.id);
  return [{ action: "void", resource: target, organizationOnly: !target.propertyId },
    { action: "void", resource: { ...target, occurredAt: paidAt }, organizationOnly: !target.propertyId },
    { action: "create", resource: { ...target, id: undefined, financialRecordId: undefined, occurredAt: now }, organizationOnly: !target.propertyId },
    ...fundingChecks(ctx, funding, saved.input.amount, paidAt, "void"), ...fundingChecks(ctx, funding, saved.input.amount, original.occurredAt, "void"), ...fundingChecks(ctx, funding, saved.input.amount, now, "void")];
}

/** Record an actual supplier disbursement against its existing claim, without recognizing another expense. */
export async function postSupplierPayment(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = supplierPaymentInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const payables = new SupplierPayableRepository(tx, ctx.organizationId); await payables.lockPaymentKey(input.idempotencyKey);
    const source = await prepareSettlement(ctx, input.id, tx, "pay"), finance = source.finance;
    const hint = await finance.findLedgerAccountById(input.fundingAccountId); if (!hint) throw new SupplierInvoiceAccessError();
    await lockWalletHolders(tx, ctx.organizationId, hint.teamWallet ? [hint.teamWallet.personId] : []);
    await new FinancialTransferRepository(tx, ctx.organizationId).lockAccounts([input.fundingAccountId]);
    const funding = await finance.findLedgerAccountById(input.fundingAccountId); if (!funding) throw new SupplierInvoiceAccessError();
    const existing = (await finance.findTransactionsByIdempotencyKeys([`supplier-payment:${input.idempotencyKey}`]))[0];
    const saved = existing ? await payables.paymentAudit(existing.id) : null;
    const savedReceipt = receipt.safeParse(saved?.after), paidAt = new Date(input.paidAt), now = await finance.clock();
    const postedAt = existing?.occurredAt ?? (input.currentPeriod ? now : paidAt);
    const target = paymentResource(ctx, source, input.amount, paidAt, existing?.id);
    const checks: Check[] = [{ action: "view", resource: target, organizationOnly: !target.propertyId },
      { action: "pay", resource: target, organizationOnly: !target.propertyId },
      { action: "create", resource: { ...target, occurredAt: postedAt }, organizationOnly: !target.propertyId },
      ...fundingChecks(ctx, funding, input.amount, paidAt, "pay"), ...fundingChecks(ctx, funding, input.amount, postedAt, "pay")];
    if (input.currentPeriod) checks.push({ action: "override", resource: target, organizationOnly: !target.propertyId });
    await source.recheckSettlement(now, checks);
    if (existing) {
      if (!savedReceipt.success || saved?.actorId !== ctx.actorId || saved.reason !== input.reason || existing.createdBy !== ctx.actorId ||
        JSON.stringify(savedReceipt.data.input) !== JSON.stringify(input) || savedReceipt.data.recognitionId !== source.existing!.id || savedReceipt.data.transactionId !== existing.id)
        throw new SupplierInvoiceConflictError();
      await source.recheckSettlement(await finance.clock(), checks);
      return { id: input.id, paymentId: existing.id, idempotent: true };
    }
    if (deps.calendar) {
      const periods = new AccountingPeriodRepository(tx, ctx.organizationId);
      await periods.lockPostingCalendar();
      await new ConfigRuleRepository(tx, ctx.organizationId).lockVersion("finance.accounting_periods", "organization", null);
      const calendar = await periods.policy(await finance.clock());
      if (!calendar || calendar.id !== deps.calendar.id || calendar.version !== deps.calendar.version ||
        new Date(localClockInstant(deps.calendar.local, calendar.value.timezone, deps.calendar.occurrence)).toISOString() !== input.paidAt) throw new SupplierInvoiceConflictError();
    }
    if (source.row.version !== input.expectedVersion || source.journals.some(journal => source.existing!.lines.some(line => line.transactionId === journal.id) && journal.reversedByTransactions.length))
      throw new SupplierInvoiceConflictError();
    const currency = await source.invoices.currency(input.currency), amount = Money.of(input.amount, input.currency);
    if (input.currency !== source.revision.currency || !currency || amount.amount.decimalPlaces() > currency.minorUnit || !isExpenseFundingAccount(funding)) throw new ExpensePolicyUnavailableError();
    if (paidAt > now) throw new SupplierInvoiceConflictError();
    const periods = new AccountingPeriodRepository(tx, ctx.organizationId);
    const closed = input.currentPeriod ? await periods.postingPeriod(paidAt) : null;
    if (input.currentPeriod && (await periods.postingOpen(paidAt) || !closed?.events[0])) throw new SupplierInvoiceConflictError();
    const claim = source.journals.flatMap(journal => journal.postings).find(posting => posting.ledgerAccount.code === "SUPPLIER_PAYABLE")?.ledgerAccount;
    if (!claim || claim.archivedAt || claim.accountType !== "CLAIM_OWNERSHIP" || claim.normalSide !== "CREDIT") throw new ExpensePolicyUnavailableError();
    const outstanding = await payables.outstanding({ supplierId: source.row.supplierId, invoiceId: input.id, currency: input.currency });
    if (amount.amount.gt(outstanding.amount)) throw new SupplierInvoiceConflictError();
    const journal = await finance.createFinancialTransaction({ reference: `SUPPLIER-PAYMENT:${input.idempotencyKey}`, description: input.reason, occurredAt: postedAt,
      idempotencyKey: `supplier-payment:${input.idempotencyKey}`, createdBy: ctx.actorId,
      postings: supplierPaymentPostings({ invoiceId: input.id, supplierId: source.row.supplierId, paymentId: input.idempotencyKey,
        liabilityAccountId: claim.id, amount, outstanding, funding }), recheckAuthorization: at => source.recheckSettlement(at, checks).then(() => undefined) });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_payment.posted", resourceType: "financial_transaction", resourceId: journal.id,
      after: { input, recognitionId: source.existing!.id, transactionId: journal.id, sourcePeriodId: closed?.id ?? null,
        sourcePeriodEventId: closed?.events[0].id ?? null, postedAt: postedAt.toISOString() }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await source.recognitions.flushGuards();
    await source.recheckSettlement(await finance.clock(), checks);
    return { id: input.id, paymentId: journal.id, idempotent: false };
  }, { timeout: 120000 });
}

/** Append an exact opposite payment journal; the claim, payment, audit and physical-account history remain intact. */
export async function voidSupplierPayment(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = supplierPaymentVoidInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const source = await prepareSettlement(ctx, input.id, tx, "void"), finance = source.finance;
    const original = source.journals.find(journal => journal.id === input.paymentId), audit = original && await source.payables.paymentAudit(original.id);
    const saved = receipt.safeParse(audit?.after);
    if (!original || !saved.success || saved.data.input.id !== input.id || original.reversesTransactionId || saved.data.transactionId !== original.id) throw new SupplierInvoiceAccessError();
    const hint = await finance.findLedgerAccountById(saved.data.input.fundingAccountId); if (!hint) throw new SupplierInvoiceAccessError();
    await lockWalletHolders(tx, ctx.organizationId, hint.teamWallet ? [hint.teamWallet.personId] : []);
    await new FinancialTransferRepository(tx, ctx.organizationId).lockAccounts([hint.id]);
    const funding = await finance.findLedgerAccountById(hint.id); if (!funding) throw new SupplierInvoiceAccessError();
    const now = await finance.clock(), checks = paymentVoidChecks(ctx, source, saved.data, original, funding, now);
    await source.recheckSettlement(now, checks);
    if (original.reversedByTransactions.length) {
      const reversalAudit = await finance.financialReversalAudit("finance.supplier_payment.reversed", "financial_transaction", [original.id]);
      if (!matchesFinancialReversalAttempt({ actorId: ctx.actorId, reason: input.reason, originalIds: [original.id], reversals: original.reversedByTransactions, audit: reversalAudit })) throw new SupplierInvoiceConflictError();
      return { id: input.id, paymentId: original.id, reversalTransactionId: original.reversedByTransactions[0].id, idempotent: true };
    }
    const reversed = await finance.createFinancialTransaction({ reference: `${original.reference}:VOID`, description: input.reason, occurredAt: now,
      idempotencyKey: `${original.idempotencyKey}:void`, reversesTransactionId: original.id, createdBy: ctx.actorId,
      postings: original.postings.map(posting => ({ ledgerAccountId: posting.ledgerAccountId, side: posting.side === "DEBIT" ? "CREDIT" as const : "DEBIT" as const,
        amount: Money.of(posting.amount.toString(), posting.currency), bucket: z.string().parse(posting.bucket), dimensions: z.record(z.string(), z.unknown()).parse(posting.dimensions) })),
      recheckAuthorization: at => source.recheckSettlement(at, checks).then(() => undefined) });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_payment.reversed", resourceType: "financial_transaction", resourceId: original.id,
      after: { invoiceId: input.id, originalTransactionIds: [original.id], reversalTransactionIds: [reversed.id] }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await source.recognitions.flushGuards(); await source.recheckSettlement(await finance.clock(), checks);
    return { id: input.id, paymentId: original.id, reversalTransactionId: reversed.id, idempotent: false };
  }, { timeout: 120000 });
}

export function inspectSupplierInvoiceSettlementSource(ctx: FinanceActorContext, id: string, tx: TenantTransaction) {
  return prepareSettlement(ctx, id, tx, "view");
}

export async function getSupplierSettlement(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = supplierSettlementQuery.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const source = await inspectSupplierInvoiceSettlementSource(ctx, input.id, tx);
    const outstanding = await source.payables.outstanding({ supplierId: source.row.supplierId, invoiceId: input.id, currency: source.revision.currency });
    const now = await source.finance.clock(), current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
    const allows = (checks: Check[]) => checks.every(check => [ctx.authContext, current].every(authority =>
      check.organizationOnly ? authorizeOrganizationSource(authority, check.action, check.resource, now) : authorize(authority, check.action, check.resource, now)));
    let sourcePay = false, sourceVoid = false;
    try { await source.checkSourceAction("pay", now); sourcePay = true; } catch (error) { if (!(error instanceof SupplierInvoiceAccessError)) throw error; }
    try { await source.checkSourceAction("void", now); sourceVoid = true; } catch (error) { if (!(error instanceof SupplierInvoiceAccessError)) throw error; }
    const periods = new AccountingPeriodRepository(tx, ctx.organizationId), calendar = await periods.policy(now), timezone = calendar?.value.timezone ?? "UTC";
    const defaultClock=input.paidLocal===undefined?localClockDefault(now.toISOString(),timezone):null;
    const paidLocal=input.paidLocal??defaultClock!.local,occurrence=input.paidLocal===undefined&&input.occurrence==="reject"?defaultClock!.occurrence:input.occurrence;
    const paidAt=new Date(localClockInstant(paidLocal,timezone,occurrence)).toISOString();
    const amount = input.amount ?? outstanding.toJSON().amount, target = paymentResource(ctx, source, amount, new Date(paidAt));
    const dateView = allows([{ action: "view", resource: target, organizationOnly: !target.propertyId }]);
    if (sourcePay && input.paidLocal && !dateView) throw new SupplierInvoiceAccessError();
    const closed = sourcePay && dateView ? !await periods.postingOpen(new Date(paidAt)) : false;
    const postingAt = closed ? now : new Date(paidAt), canAdjust = allows([{ action: "override", resource: target, organizationOnly: !target.propertyId }]);
    const claimReversed = source.journals.some(journal => source.existing!.lines.some(line => line.transactionId === journal.id) && journal.reversedByTransactions.length > 0);
    const canPreparePayment = Boolean(sourcePay && calendar && outstanding.amount.gt(0) && !claimReversed);
    const currentPostingOpen = sourceVoid ? await periods.postingOpen(now) : false;
    const canPay = Boolean(canPreparePayment && new Date(paidAt) <= now && dateView &&
      allows([{ action: "pay", resource: target, organizationOnly: !target.propertyId }, { action: "create", resource: { ...target, occurredAt: postingAt }, organizationOnly: !target.propertyId }]) &&
      (!closed || canAdjust && await periods.postingOpen(now)));
    const accounts: FinanceLedgerAccount[] = []; let cursor = input.fundingAfter;
    const eligible = (account: FinanceLedgerAccount) => isExpenseFundingAccount(account) && allows([
      ...fundingChecks(ctx, account, amount, new Date(paidAt), "pay"), ...fundingChecks(ctx, account, amount, postingAt, "pay")]);
    if (canPay) {
      while (accounts.length < 51) {
        const batch = await source.finance.listLedgerAccounts({ after: cursor, query: input.fundingQuery, take: 100 }); if (!batch.length) break;
        for (const account of batch) { if (eligible(account)) accounts.push(account); if (accounts.length === 51) break; }
        if (batch.length < 100) break; cursor = batch.at(-1)!.id;
      }
    }
    const fundingNext = accounts.length > 50 ? accounts[49].id : null, choices = accounts.slice(0, 50);
    if (canPay && input.fundingAccountId && !choices.some(account => account.id === input.fundingAccountId)) {
      const selected = await source.finance.findLedgerAccountById(input.fundingAccountId); if (!selected || !eligible(selected)) throw new SupplierInvoiceAccessError(); choices.push(selected);
    }
    const currency = await source.invoices.currency(source.revision.currency); if (!currency) throw new ExpensePolicyUnavailableError();
    const payments = source.journals.filter(journal => !journal.reversesTransactionId && journal.postings.some(posting => posting.bucket === "SUPPLIER_PAYMENT") && (!input.before || journal.id < input.before));
    const result = { id: input.id, version: source.row.version, outstanding: outstanding.toJSON(), timezone, canPay, canPreparePayment, claimReversed, minorUnit: currency.minorUnit,
      preview: { paidLocal, paidAt, occurrence, closed, canAdjust, calendarRuleId: calendar?.id ?? null, calendarRuleVersion: calendar?.version ?? null },
      accounts: choices.map(account => ({ id: account.id, name: account.name })), fundingNext,
      payments: payments.slice(0, 50).map(journal => {
        const saved = source.paymentReceipts.get(journal.id), funding = journal.postings.find(posting => posting.ledgerAccount.code !== "SUPPLIER_PAYABLE")?.ledgerAccount;
        if (!saved || !funding) throw new SupplierInvoiceConflictError();
        return { id: journal.id, amount: Money.of(journal.postings[0].amount.toString(), source.revision.currency).toJSON(), occurredAt: journal.occurredAt.toISOString(),
          paidAt: saved.input.paidAt, reference: saved.input.reference, reason: saved.input.reason, fundingName: funding.name, reversed: Boolean(journal.reversedByTransactions.length),
          canVoid: sourceVoid && currentPostingOpen && !journal.reversedByTransactions.length && allows(paymentVoidChecks(ctx, source, saved, journal, funding, now)) };
      }), next: payments.length > 50 ? payments[49].id : null };
    await source.recheckSettlement(await source.finance.clock(), [
      ...(input.paidLocal && sourcePay ? [{ action: "view" as const, resource: target, organizationOnly: !target.propertyId }] : []),
      ...choices.flatMap(account => [...fundingChecks(ctx, account, amount, new Date(paidAt), "view"), ...fundingChecks(ctx, account, amount, postingAt, "view")])
    ]);
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...supplierInvoiceOrganizationResource(ctx.organizationId), data: result },
      catalogFieldPolicy<typeof result>("supplier_invoice"), await source.finance.clock()) as typeof result;
  }, { timeout: 120000 });
}

/** One source check for direct execution and durable admission; every original cost remains authoritative. */
export async function prepareSupplierInvoiceReversal(ctx: FinanceActorContext, raw: unknown, tx: TenantTransaction) {
  const input = supplierInvoiceReversalInput.parse(raw), source = await prepareSettlement(ctx, input.id, tx, "void");
  const now = await source.finance.clock(), total = Money.of(source.revision.amount.toString(), source.revision.currency);
  const checks: Check[] = source.costs.flatMap(cost => {
    const line = source.revision.lines.find(line => line.id === cost.id)!;
    const resource = supplierInvoiceCostResource(ctx.organizationId, source.row, line, total, source.source.occurredOn.toISOString().slice(0, 10), cost.timezone, cost.sourceOccurredAt);
    const current = { ...resource, type: "financial_transaction", id: undefined, financialRecordId: undefined, occurredAt: now };
    return [{ action: "view", resource: current, organizationOnly: !line.propertyId }, { action: "create", resource: current, organizationOnly: !line.propertyId }];
  });
  const recheck = (at: Date) => source.recheckSettlement(at, checks);
  await recheck(now);
  if (source.row.version !== input.expectedVersion) throw new SupplierInvoiceConflictError();
  const originals = source.costs.map(cost => {
    const link = source.existing!.lines.find(link => link.invoiceLineId === cost.id), journal = source.journals.find(journal => journal.id === link?.transactionId);
    if (!journal || journal.reversesTransactionId) throw new SupplierInvoiceConflictError(); return journal;
  });
  const reversals = originals.flatMap(journal => journal.reversedByTransactions);
  if (reversals.length) {
    const audit = await source.finance.financialReversalAudit("finance.supplier_invoice.reversed", "supplier_invoice", [input.id]);
    const intent = z.object({ idempotencyKey: z.uuid(), invoiceVersion: z.number().int() }).safeParse(audit?.after);
    if (reversals.length !== originals.length || !intent.success || intent.data.idempotencyKey !== input.idempotencyKey || intent.data.invoiceVersion !== input.expectedVersion ||
      !matchesFinancialReversalAttempt({ actorId: ctx.actorId, reason: input.reason, originalIds: originals.map(journal => journal.id), reversals, audit })) throw new SupplierInvoiceConflictError();
  } else {
    if (source.journals.some(journal => !journal.reversesTransactionId && journal.postings.some(posting => posting.bucket === "SUPPLIER_PAYMENT") && !journal.reversedByTransactions.length))
      throw new SupplierInvoiceConflictError();
    const outstanding = await source.payables.outstanding({ supplierId: source.row.supplierId, invoiceId: input.id, currency: source.revision.currency });
    if (!outstanding.amount.eq(total.amount)) throw new SupplierInvoiceConflictError();
    await new AccountingPeriodRepository(tx, ctx.organizationId).assertPostingOpen(now);
  }
  return { ...source, input, originals, reversals, now, recheckReversal: recheck };
}

/** Append the exact opposite of every original claim atomically after all actual payments were reversed. */
export async function voidSupplierInvoiceClaim(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const source = await prepareSupplierInvoiceReversal(ctx, raw, tx), { input, originals, now } = source;
    if (source.reversals.length) {
      await source.recheckReversal(await source.finance.clock());
      return { id: input.id, recognitionId: source.existing!.id,
        reversalTransactionIds: originals.map(original => source.reversals.find(reversal => reversal.reversesTransactionId === original.id)!.id), idempotent: true };
    }
    const reversals = await source.finance.createFinancialTransactions(originals.map(original => ({ reference: original.reference + ":VOID", description: input.reason,
      occurredAt: now, idempotencyKey: original.idempotencyKey + ":void", reversesTransactionId: original.id, createdBy: ctx.actorId,
      postings: original.postings.map(posting => ({ ledgerAccountId: posting.ledgerAccountId, side: posting.side === "DEBIT" ? "CREDIT" as const : "DEBIT" as const,
        amount: Money.of(posting.amount.toString(), posting.currency), bucket: z.string().parse(posting.bucket), dimensions: z.record(z.string(), z.unknown()).parse(posting.dimensions) })) })),
      at => source.recheckReversal(at).then(() => undefined));
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.reversed", resourceType: "supplier_invoice", resourceId: input.id,
      after: { recognitionId: source.existing!.id, invoiceVersion: input.expectedVersion, idempotencyKey: input.idempotencyKey,
        originalTransactionIds: originals.map(original => original.id), reversalTransactionIds: reversals.map(reversal => reversal.id) },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    await source.recognitions.flushGuards(); await source.recheckReversal(await source.finance.clock());
    const outstanding = await source.payables.outstanding({ supplierId: source.row.supplierId, invoiceId: input.id, currency: source.revision.currency });
    if (!outstanding.amount.isZero()) throw new SupplierInvoiceConflictError();
    return { id: input.id, recognitionId: source.existing!.id, reversalTransactionIds: reversals.map(reversal => reversal.id), idempotent: false };
  }, { timeout: 120000 });
}
