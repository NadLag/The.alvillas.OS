import { commandFingerprint } from "@/platform/http/command-fingerprint";
import type { BankStatementPolicy } from "@/platform/config/bank-statement-policy";
import { parseBankStatementCsv } from "./bank-statement-csv";
import { parseBankStatementOfx } from "./bank-statement-ofx";
import { bankStatementFactSchema, bankStatementCurrencyEvidenceByOrder, BankStatementConfigurationError, BankStatementConflictError, type ParsedBankStatement } from "./bank-statement";
export * from "./bank-statement";

/** FITIDs belong to a financial institution and actual account, independently of currency or import file. */
export function bankStatementBankIdentity(account: BankStatementPolicy["accounts"][number]): string {
  return commandFingerprint([account.bank_id, account.branch_id, account.account_id]);
}
export function bankStatementLineIdentity(bankIdentity: string, fileHash: string, sourceOrder: number, externalId: string | null): string {
  return externalId ? commandFingerprint(["FITID", bankIdentity, externalId]) : commandFingerprint(["CSV", bankIdentity, fileHash, sourceOrder]);
}

export function parseBankStatementSource(source: string, format: "CSV" | "OFX", policy: BankStatementPolicy, account: BankStatementPolicy["accounts"][number], minorUnits: number): ParsedBankStatement {
  let result: ParsedBankStatement;
  if (format === "CSV") {
    if (!account.csv) throw new BankStatementConfigurationError();
    const rows = parseBankStatementCsv(source, { ...account.csv, currency: account.currency, amountFormat: { decimalSeparator: account.csv.decimalSeparator, groupingSeparator: account.csv.groupingSeparator, minorUnits } });
    result = { statement: { format: "CSV", bankId: account.bank_id, branchId: account.branch_id, accountId: account.account_id, accountType: account.account_type, currency: account.currency, pendingCount: 0 },
      lines: rows.map(row => ({ sourceOrder: row.sourceOrder, fact: bankStatementFactSchema.parse({ externalId: row.externalId, correction: null, postedDate: row.postedDate, sourceTimestamp: null, amount: row.amount, name: row.description, memo: null, reference: row.reference, transactionType: null }) })) };
  } else {
    if (!account.ofx) throw new BankStatementConfigurationError();
    const statements = parseBankStatementOfx(source, minorUnits);
    if (statements.length !== 1) throw new BankStatementConflictError();
    const statement = statements[0];
    if (statement.bankId !== account.bank_id || statement.branchId !== account.branch_id || statement.accountId !== account.account_id || statement.accountType !== account.account_type || statement.currency !== account.currency) throw new BankStatementConflictError();
    const { lines, ...metadata } = statement;
    const evidence = bankStatementCurrencyEvidenceByOrder(metadata);
    result = { statement: { format: "OFX", ...metadata }, lines: lines.map(({ sourceOrder, ...fact }) => ({ sourceOrder, fact: bankStatementFactSchema.parse(fact), ...(evidence.has(sourceOrder) ? { currencyEvidence: evidence.get(sourceOrder)! } : {}) })) };
  }
  if (result.lines.length > policy.max_rows) throw new BankStatementConflictError();
  return result;
}
