import { z } from "zod";
import { csvTable } from "@/platform/imports/csv";
import { Money } from "@/platform/money/money";
import { bankStatementAmount, type BankAmountFormat } from "./bank-statement-amount";

type CsvColumns = { postedDate: string; transactionId?: string | null; reference: string | null; description: string; currency: string | null } &
  ({ amount: string; debit?: never; credit?: never } | { amount?: never; debit: string; credit: string });
export type BankCsvMapping = {
  delimiter: "," | ";" | "\t";
  dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";
  currency: string;
  amountFormat: BankAmountFormat;
  columns: CsvColumns;
};
export type BankCsvLine = {
  sourceOrder: number;
  postedDate: string;
  amount: { amount: string; currency: string };
  externalId: string | null;
  reference: string | null;
  description: string;
  source: Record<string, string>;
};

function postedDate(source: string, format: BankCsvMapping["dateFormat"]): string {
  if (format === "YYYY-MM-DD") return z.iso.date().parse(source);
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(source);
  if (!match) throw new Error("invalid_bank_date");
  return z.iso.date().parse(`${match[3]}-${format === "DD/MM/YYYY" ? match[2] : match[1]}-${format === "DD/MM/YYYY" ? match[1] : match[2]}`);
}

/** Mapping comes from a retained tenant policy; no amount/date guessing or duplicate-row removal. */
export function parseBankStatementCsv(csv: string, mapping: BankCsvMapping): BankCsvLine[] {
  const { columns: header, records } = csvTable(csv, { delimiter: mapping.delimiter, allowEmptyRows: true, maxRows: 5001 });
  const columns = Object.values(mapping.columns).filter((value): value is string => value !== null && value !== undefined);
  if (new Set(columns).size !== columns.length || columns.some(column => !header.includes(column)))
    throw new Error("invalid_bank_csv_mapping");
  const result = records.map((source, index) => {
    if (mapping.columns.currency && source[mapping.columns.currency] !== mapping.currency) throw new Error("bank_currency_mismatch");
    let amount: Money;
    if (mapping.columns.amount !== undefined) amount = bankStatementAmount(source[mapping.columns.amount], mapping.currency, mapping.amountFormat);
    else {
      const debitSource = source[mapping.columns.debit], creditSource = source[mapping.columns.credit];
      const debit = debitSource ? bankStatementAmount(debitSource, mapping.currency, mapping.amountFormat) : Money.zero(mapping.currency);
      const credit = creditSource ? bankStatementAmount(creditSource, mapping.currency, mapping.amountFormat) : Money.zero(mapping.currency);
      if (debit.amount.isNegative() || credit.amount.isNegative() || (!debit.amount.isZero() && !credit.amount.isZero()))
        throw new Error("ambiguous_bank_debit_credit");
      amount = credit.subtract(debit);
    }
    return { sourceOrder: index + 1, postedDate: postedDate(source[mapping.columns.postedDate], mapping.dateFormat),
      amount: amount.toJSON(), externalId: mapping.columns.transactionId ? source[mapping.columns.transactionId] || null : null,
      reference: mapping.columns.reference ? source[mapping.columns.reference] || null : null,
      description: source[mapping.columns.description], source };
  });
  const ids = result.flatMap(line => line.externalId ? [line.externalId] : []);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate_csv_bank_transaction_id");
  return result;
}
