import { z } from "zod";
import { Money } from "@/platform/money/money";
import { explicitNotificationRoutingSchema } from "@/platform/notifications/notification-routing";

export const ledgerIntegrityPolicyKey = "finance.ledger_integrity";
export const ledgerIntegrityRoutingKey = "notification.routing.ledger_integrity_failed";
export const ledgerIntegrityRoutingSchema = explicitNotificationRoutingSchema;
const accountTypes = z.array(z.string().trim().min(1).max(100)).min(1).max(100);
export const ledgerIntegrityPolicySchema = z.object({
  run_at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
  page_size: z.number().int().min(1).max(10000),
  max_findings: z.number().int().min(1).max(10000),
  account_types: z.object({ locations: accountTypes, claims: accountTypes, company: accountTypes }).strict()
}).strict().superRefine((value, context) => {
  const types = Object.values(value.account_types).flat();
  if (new Set(types).size !== types.length) context.addIssue({ code: "custom", path: ["account_types"], message: "Ledger account classifications must be disjoint" });
});
export type LedgerIntegrityPolicy = z.infer<typeof ledgerIntegrityPolicySchema>;
export type IntegrityMovement = { id: string; transactionId: string; accountId: string; currency: string; amount: string; side: string; accountType: string; validScope: boolean };
export type IntegrityAccount = { id: string; currency: string; debits: string; credits: string };
export type IntegrityTransaction = { id: string; currency: string | null; debits: string; credits: string; postingCount: string; sealed: boolean };
export type IntegrityFinding = { code: "INVALID_MONEY" | "INVALID_SIDE" | "TENANT_DIMENSIONS" | "UNCLASSIFIED_ACCOUNT" | "ACCOUNT_BALANCE" | "TRANSACTION_BALANCE" | "UNSEALED_TRANSACTION" | "EMPTY_TRANSACTION" | "TRIAL_BALANCE" | "RETAINED_HISTORY" | "CLOSED_PERIOD" | "INCOMPLETE_CHECK"; sourceId: string | null; currency: string | null };
type Totals = { debit: Money; credit: Money };
const totals = (currency: string): Totals => ({ debit: Money.zero(currency), credit: Money.zero(currency) });
const key = (id: string, currency: string) => id + ":" + currency;

/** Independent exact reconstruction from original movements; no financial row is repaired. */
export class LedgerIntegrityRebuild {
  private readonly accounts = new Map<string, Totals>();
  private readonly transactions = new Map<string, Totals & { count: bigint }>();
  private readonly trial = new Map<string, { locations: Money; claims: Money; company: Money }>();
  private readonly findings: IntegrityFinding[] = [];
  private failureCount = 0n;
  private movementCount = 0n;
  private finalized = false;
  private accountsCompared = false;
  private transactionsCompared = false;
  constructor(private readonly policy: LedgerIntegrityPolicy) {}

  finding(code: IntegrityFinding["code"], sourceId: string | null, currency: string | null, count = 1n) {
    if (this.finalized) throw Error("Integrity reconstruction is already complete");
    if (count <= 0n) return;
    this.failureCount += count;
    if (this.findings.length < this.policy.max_findings) this.findings.push({ code, sourceId, currency });
  }

  add(row: IntegrityMovement) {
    if (this.finalized) throw Error("Integrity reconstruction is already complete");
    this.movementCount++;
    if (!row.validScope) this.finding("TENANT_DIMENSIONS", row.id, row.currency);
    if (row.side !== "DEBIT" && row.side !== "CREDIT") { this.finding("INVALID_SIDE", row.id, row.currency); return; }
    let amount: Money;
    try {
      if (!/^\d+\.\d{2}$/u.test(row.amount)) throw Error("Original cents required");
      amount = Money.of(row.amount, row.currency);
      if (!amount.amount.gt(0)) throw Error("Positive original amount required");
    } catch { this.finding("INVALID_MONEY", row.id, row.currency); return; }
    const accountKey = key(row.accountId, row.currency), account = this.accounts.get(accountKey) ?? totals(row.currency),
      transactionKey = key(row.transactionId, row.currency), transaction = this.transactions.get(transactionKey) ?? { ...totals(row.currency), count: 0n };
    if (row.side === "DEBIT") { account.debit = account.debit.add(amount); transaction.debit = transaction.debit.add(amount); }
    else { account.credit = account.credit.add(amount); transaction.credit = transaction.credit.add(amount); }
    transaction.count++; this.accounts.set(accountKey, account); this.transactions.set(transactionKey, transaction);
    const position = this.trial.get(row.currency) ?? { locations: Money.zero(row.currency), claims: Money.zero(row.currency), company: Money.zero(row.currency) },
      group = this.policy.account_types.locations.includes(row.accountType) ? "locations" : this.policy.account_types.claims.includes(row.accountType) ? "claims" : this.policy.account_types.company.includes(row.accountType) ? "company" : null;
    if (!group) this.finding("UNCLASSIFIED_ACCOUNT", row.accountId, row.currency);
    else position[group] = row.side === (group === "locations" ? "DEBIT" : "CREDIT") ? position[group].add(amount) : position[group].subtract(amount);
    this.trial.set(row.currency, position);
  }

  compareAccounts(rows: readonly IntegrityAccount[]) {
    if (this.finalized) throw Error("Integrity reconstruction is already complete");
    const remaining = new Map(this.accounts);
    for (const row of rows) {
      const id = key(row.id, row.currency), rebuilt = remaining.get(id); remaining.delete(id);
      if (!rebuilt || !rebuilt.debit.equals(Money.of(row.debits, row.currency)) || !rebuilt.credit.equals(Money.of(row.credits, row.currency))) this.finding("ACCOUNT_BALANCE", row.id, row.currency);
    }
    for (const id of remaining.keys()) { const split = id.lastIndexOf(":"); this.finding("ACCOUNT_BALANCE", id.slice(0, split), id.slice(split + 1)); }
    this.accountsCompared = true;
  }

  compareTransactions(rows: readonly IntegrityTransaction[]) {
    if (this.finalized) throw Error("Integrity reconstruction is already complete");
    const remaining = new Map(this.transactions), unsealed = new Set<string>();
    for (const row of rows) {
      if (!row.sealed && !unsealed.has(row.id)) { this.finding("UNSEALED_TRANSACTION", row.id, row.currency); unsealed.add(row.id); }
      if (!row.currency || BigInt(row.postingCount) === 0n) { this.finding("EMPTY_TRANSACTION", row.id, row.currency); continue; }
      const id = key(row.id, row.currency), rebuilt = remaining.get(id); remaining.delete(id);
      if (!rebuilt || rebuilt.count !== BigInt(row.postingCount) || !rebuilt.debit.equals(rebuilt.credit) ||
        !rebuilt.debit.equals(Money.of(row.debits, row.currency)) || !rebuilt.credit.equals(Money.of(row.credits, row.currency))) this.finding("TRANSACTION_BALANCE", row.id, row.currency);
    }
    for (const id of remaining.keys()) { const split = id.lastIndexOf(":"); this.finding("TRANSACTION_BALANCE", id.slice(0, split), id.slice(split + 1)); }
    this.transactionsCompared = true;
  }

  finish() {
    if (!this.finalized && this.failureCount === 0n && (!this.accountsCompared || !this.transactionsCompared)) this.finding("INCOMPLETE_CHECK", null, null);
    const currencies = [...this.trial].sort(([a], [b]) => a.localeCompare(b)).map(([currency, position]) => {
      if (!this.finalized && !position.locations.equals(position.claims.add(position.company))) this.finding("TRIAL_BALANCE", null, currency);
      return { currency, locations: position.locations.toJSON().amount, claims: position.claims.toJSON().amount, company: position.company.toJSON().amount };
    });
    this.finalized = true;
    return { version: 1 as const, passed: this.failureCount === 0n, movements: this.movementCount.toString(), failureCount: this.failureCount.toString(),
      findings: [...this.findings], findingsTruncated: this.failureCount > BigInt(this.findings.length), currencies };
  }
}
