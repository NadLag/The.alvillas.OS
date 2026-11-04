import { z } from "zod";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicyKey, bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { Money } from "@/platform/money/money";
import { AccountantBankExportRepository } from "../infrastructure/accountant-bank-export-repository";
import { BankReconciliationRepository } from "../infrastructure/bank-reconciliation-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { bankStatementSourceStates, type BankSourceFact } from "../domain/bank-statement-source-state";
import { bankStatementFactSchema } from "../domain/bank-statement";
import { bankReconciliationPlanSchema } from "../domain/bank-reconciliation-command";
import { accountantExportRow, AccountantExportAccessError, AccountantExportCapacityError, AccountantExportConfigurationError, AccountantExportSourceError,
  type AccountantExportInput, type AccountantExportColumn, type AccountantExportNativeSnapshot } from "../domain/accountant-export";

const columns: AccountantExportColumn[] = ["recordType", "sourceId", "transactionId", "postingId", "statementLineId", "reconciliationId", "releaseId", "reference", "occurredAt", "postedOn", "description", "currency",
  "accountId", "accountCode", "accountType", "normalSide", "side", "amount", "expected", "actual", "variance", "allocated", "remaining", "state", "reversesTransactionId"];
const base = z.object({ id: z.uuid(), entryId: z.uuid(), accountId: z.uuid(), currency: z.string().regex(/^[A-Z]{3}$/u) });
const matchSchema = base.extend({ snapshot: bankReconciliationPlanSchema, policySnapshot: z.unknown(), reason: z.string(), releaseId: z.uuid().nullable(), createdAt: z.iso.datetime({ offset: true }) }).strict();
const allocationSchema = base.extend({ postingId: z.uuid().nullable(), lineId: z.uuid().nullable(), amount: z.string(), original: z.string(), allocatedBefore: z.string(), sourceSnapshot: z.unknown() }).strict();
const evidenceSchema = base.extend({ lineId: z.uuid(), sourceSnapshot: z.unknown() }).strict();
const batches = <T,>(values: readonly T[]) => Array.from({ length: Math.ceil(values.length / 5000) }, (_, index) => values.slice(index * 5000, (index + 1) * 5000));
const magnitude = (value: Money) => value.amount.lt(0) ? Money.zero(value.currency).subtract(value) : value;

export async function accountantBankExportAccounts(tx: TenantTransaction, organizationId: string, currency: string) {
  const rule = await new ConfigRuleRepository(tx, organizationId).resolve({ key: bankStatementPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: await new FinanceRepository(tx, organizationId).clock() });
  const configured = rule ? bankStatementPolicySchema.safeParse(rule.value) : null;
  if (configured && !configured.success) throw new AccountantExportConfigurationError();
  const accounts = await new AccountantBankExportRepository(tx, organizationId).accounts(currency, configured?.success ? configured.data.accounts.filter(account => account.currency === currency).map(account => account.account_code) : []);
  return { rule, accounts };
}

/** Original provider correction families and the existing matching-state evaluator remain authoritative. */
export async function captureAccountantBankSource(tx: TenantTransaction, organizationId: string, input: AccountantExportInput,
  range: { startsAt: Date; endsAt: Date }, maxRows: number): Promise<AccountantExportNativeSnapshot> {
  const repository = new AccountantBankExportRepository(tx, organizationId), native = new BankReconciliationRepository(tx, organizationId);
  const { rule, accounts: allAccounts } = await accountantBankExportAccounts(tx, organizationId, input.currency);
  if (input.accountId && !allAccounts.some(account => account.id === input.accountId)) throw new AccountantExportAccessError();
  const accounts = allAccounts.filter(account => !input.accountId || account.id === input.accountId), accountIds = accounts.map(account => account.id), byAccount = new Map(accounts.map(account => [account.id, account]));
  const expected = await repository.expected({ accountIds, currency: input.currency, ...range, maxRows });
  const seeds = await repository.lineIds({ accountIds, currency: input.currency, fromOn: input.fromOn, toOn: input.toOn, ...range, maxRows });
  if (expected.length + seeds.length > maxRows) throw new AccountantExportCapacityError();
  const families = new Map<string, BankSourceFact>();
  for (const ids of batches(seeds.map(row => row.id))) for (const fact of await native.families(ids)) families.set(fact.id, fact);
  if (expected.length + families.size > maxRows) throw new AccountantExportCapacityError();
  const lines = await repository.lines([...families.keys()]);
  if (lines.length !== families.size || lines.some(line => !byAccount.has(line.ledgerAccountId) || line.currency !== input.currency)) throw new AccountantExportSourceError();
  const history = await repository.history({ accountIds, currency: input.currency, postingIds: expected.map(row => row.id), lineIds: lines.map(row => row.id), maxRows: maxRows - expected.length - lines.length });
  if (expected.length + lines.length + history.length > maxRows) throw new AccountantExportCapacityError();
  const matches = history.filter(row => row.kind === "MATCH").map(row => matchSchema.parse(row.data)), byMatch = new Map(matches.map(row => [row.id, row]));
  const states = new Map<string, string>();
  for (const ids of batches(matches.map(row => row.id))) for (const [id, state] of await native.states(ids)) states.set(id, state);
  const allocations = new Map<string, string>();
  for (const ids of batches(expected.map(row => row.id))) for (const [id, amount] of await native.allocated(ids, [])) allocations.set(id, amount);
  for (const ids of batches(lines.map(row => row.id))) for (const [id, amount] of await native.allocated([], ids)) allocations.set(id, amount);
  const familyStates = bankStatementSourceStates([...families.values()]);
  const rows: AccountantExportNativeSnapshot["rows"] = [];
  const append = (identity: string, accountId: string, values: Record<string, string | null>) => {
    const account = byAccount.get(accountId); if (!account) throw new AccountantExportSourceError();
    const empty: Record<string, string | null> = Object.fromEntries(columns.map(column => [column, null]));
    rows.push(accountantExportRow(identity, columns, { ...empty, currency: input.currency, accountId, accountCode: account.code, accountType: account.accountType, normalSide: account.normalSide, ...values }));
  };
  for (const posting of expected) {
    if (!["DEBIT", "CREDIT"].includes(posting.side)) throw new AccountantExportSourceError();
    const original = Money.of(posting.amount, input.currency), allocated = Money.of(allocations.get("EXPECTED:" + posting.id) ?? "0.00", input.currency), remaining = original.subtract(allocated);
    if (original.amount.lte(0) || remaining.amount.lt(0)) throw new AccountantExportSourceError();
    append("expected:" + posting.id, posting.accountId, { recordType: "BANK_EXPECTED", sourceId: posting.id, transactionId: posting.transactionId, postingId: posting.id,
      reference: posting.reference, occurredAt: posting.occurredAt, description: posting.description, side: posting.side, amount: posting.amount,
      expected: (posting.side === "CREDIT" ? Money.zero(input.currency).subtract(original) : original).toJSON().amount, allocated: allocated.toJSON().amount, remaining: remaining.toJSON().amount,
      reversesTransactionId: posting.reversesTransactionId, state: posting.reversalIds.length ? "REVERSED" : allocated.amount.isZero() ? "UNMATCHED" : remaining.amount.isZero() ? "MATCHED" : "PARTIAL" });
  }
  for (const line of lines) {
    const fact = bankStatementFactSchema.parse(line.source), state = familyStates.get(line.id);
    if (!state || fact.amount?.currency !== undefined && fact.amount.currency !== input.currency || fact.amount?.amount !== (line.amount ?? undefined) || fact.postedDate !== line.postedOn) throw new AccountantExportSourceError();
    const allocated = Money.of(allocations.get("ACTUAL:" + line.id) ?? "0.00", input.currency), remaining = line.amount === null ? null : magnitude(Money.of(line.amount, input.currency)).subtract(allocated);
    if (remaining?.amount.lt(0)) throw new AccountantExportSourceError();
    append("line:" + line.id, line.ledgerAccountId, { recordType: "BANK_ACTUAL", sourceId: line.id, statementLineId: line.id, reference: fact.reference ?? line.externalId,
      occurredAt: null, postedOn: line.postedOn, description: [fact.name, fact.memo].filter(value => value !== null).join("\n") || null,
      amount: line.amount, actual: line.amount, allocated: allocated.toJSON().amount, remaining: remaining?.toJSON().amount ?? null, state });
  }
  for (const record of history) {
    if (record.kind === "MATCH") {
      const entry = matchSchema.parse(record.data), state = states.get(entry.id);
      if (!state || entry.currency !== input.currency || entry.snapshot.unit !== "MONEY:" + input.currency || !Money.of(entry.snapshot.actual, input.currency).subtract(Money.of(entry.snapshot.expected, input.currency)).equals(Money.of(entry.snapshot.variance, input.currency))) throw new AccountantExportSourceError();
      append("match:" + entry.id, entry.accountId, { recordType: "BANK_MATCH", sourceId: entry.id, reconciliationId: entry.id, releaseId: entry.releaseId,
        reference: entry.id, occurredAt: entry.createdAt, description: entry.reason, expected: entry.snapshot.expected, actual: entry.snapshot.actual, variance: entry.snapshot.variance, state });
    } else if (record.kind === "ALLOCATION") {
      const allocation = allocationSchema.parse(record.data), parent = byMatch.get(allocation.entryId), state = states.get(allocation.entryId);
      if (!parent || !state || allocation.currency !== input.currency || allocation.accountId !== parent.accountId || Boolean(allocation.postingId) === Boolean(allocation.lineId)) throw new AccountantExportSourceError();
      const amount = Money.of(allocation.amount, input.currency), signed = Money.of(allocation.original, input.currency).amount.lt(0) ? Money.zero(input.currency).subtract(amount) : amount;
      append("allocation:" + allocation.id, allocation.accountId, { recordType: allocation.postingId ? "BANK_EXPECTED_ALLOCATION" : "BANK_ACTUAL_ALLOCATION", sourceId: allocation.id,
        reconciliationId: allocation.entryId, postingId: allocation.postingId, statementLineId: allocation.lineId, amount: allocation.amount,
        expected: allocation.postingId ? signed.toJSON().amount : null, actual: allocation.lineId ? signed.toJSON().amount : null, state });
    } else {
      const evidence = evidenceSchema.parse(record.data), parent = byMatch.get(evidence.entryId), state = states.get(evidence.entryId);
      if (!parent || !state || evidence.currency !== input.currency || evidence.accountId !== parent.accountId) throw new AccountantExportSourceError();
      append("evidence:" + record.identity, evidence.accountId, { recordType: "BANK_REMOVAL_EVIDENCE", sourceId: evidence.lineId, statementLineId: evidence.lineId, reconciliationId: evidence.entryId, state });
    }
  }
  return { columns, rows, fingerprint: commandFingerprint({ rule, accounts, expected, lines, history, states: [...states].sort(), allocations: [...allocations].sort(), families: [...families.values()].sort((a, b) => a.id.localeCompare(b.id)) }) };
}
