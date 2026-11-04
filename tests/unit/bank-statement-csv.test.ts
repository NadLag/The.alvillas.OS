import { describe, expect, it } from "vitest";
import { parseBankStatementCsv, type BankCsvMapping } from "@/modules/finance/domain/bank-statement-csv";
import { bankStatementAmount } from "@/modules/finance/domain/bank-statement-amount";
import { csvRecords } from "@/platform/imports/csv";

const format = { decimalSeparator: ",", groupingSeparator: " ", minorUnits: 2 } as const;
const mapping: BankCsvMapping = { delimiter: ";", dateFormat: "DD/MM/YYYY", currency: "MAD", amountFormat: format,
  columns: { postedDate: "date", amount: "montant", reference: "reference", description: "libelle", currency: "devise" } };
const header = "Date;Montant;Reference;Libelle;Devise\r\n";
describe("retained bank statement source parsing", () => {
  it("uses explicit mapping, exact signed Money and original source order including identical rows", () => {
    const row = '03/11/2026;-9 999 999 999 999 999,99;;"Virement, reçu";MAD';
    const lines = parseBankStatementCsv("\uFEFF" + header + row + "\r\n" + row, mapping);
    expect(lines.map(line => line.sourceOrder)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({ postedDate: "2026-11-03", amount: { amount: "-9999999999999999.99", currency: "MAD" }, externalId: null, description: "Virement, reçu" });
    expect(lines[0].source.montant).toBe("-9 999 999 999 999 999,99");
  });
  it.each(["1e3", "1,001", "1,", ",01", "1 00,00", "1.00", "NaN", "Infinity", "(1,00)", "1 000 0,00", "--1", "", "1,2,3"])("rejects lossy or ambiguous source amount %s", value => {
    expect(() => bankStatementAmount(value, "MAD", format)).toThrow();
  });
  it.each(["2026-02-29", "2026-13-01", "2026-04-31"])("rejects nonexistent calendar date %s", date => {
    expect(() => parseBankStatementCsv(header + `${date};1,00;r;item;MAD`, { ...mapping, dateFormat: "YYYY-MM-DD" })).toThrow();
  });
  it("does not guess ambiguous day/month order", () => {
    const input = header + "03/04/2026;1,00;r;item;MAD";
    expect(parseBankStatementCsv(input, mapping)[0].postedDate).toBe("2026-04-03");
    expect(parseBankStatementCsv(input, { ...mapping, dateFormat: "MM/DD/YYYY" })[0].postedDate).toBe("2026-03-04");
  });
  it("rejects foreign currencies, reused mappings and missing columns", () => {
    expect(() => parseBankStatementCsv(header + "03/11/2026;1,00;r;item;EUR", mapping)).toThrow("bank_currency_mismatch");
    expect(() => parseBankStatementCsv(header + "03/11/2026;1,00;r;item;MAD", { ...mapping, columns: { ...mapping.columns, description: "missing" } })).toThrow("invalid_bank_csv_mapping");
    expect(() => parseBankStatementCsv(header + "03/11/2026;1,00;r;item;MAD", { ...mapping, columns: { ...mapping.columns, description: "reference" } })).toThrow("invalid_bank_csv_mapping");
  });
  it("parses separate nonnegative debit and credit columns without netting contradictory values", () => {
    const split: BankCsvMapping = { ...mapping, columns: { postedDate: "date", debit: "debit", credit: "credit", reference: null, description: "description", currency: null } };
    const input = "Date;Debit;Credit;Description\n03/11/2026;0,01;;sortie\n03/11/2026;;0,02;entrée";
    expect(parseBankStatementCsv(input, split).map(line => line.amount.amount)).toEqual(["-0.01", "0.02"]);
    for (const cells of ["1,00;1,00", "-1,00;", ";-1,00"]) expect(() => parseBankStatementCsv("Date;Debit;Credit;Description\n03/11/2026;" + cells + ";item", split)).toThrow("ambiguous_bank_debit_credit");
  });
  it("preserves quoted multiline descriptions and refuses malformed fields", () => {
    expect(parseBankStatementCsv(header + '03/11/2026;+0,01;r;"ligne 1\nligne 2; ""original""";MAD', mapping)[0].description).toBe('ligne 1\nligne 2; "original"');
    expect(() => parseBankStatementCsv(header + '03/11/2026;1,00;r;"unclosed;MAD', mapping)).toThrow();
  });
  it("retains the shared CSV default and accepts an explicit delimiter despite quoted header commas", () => {
    expect(csvRecords("A,B\n1,2")).toEqual([{ a: "1", b: "2" }]);
    expect(csvRecords('"A,B,C";D\n1;2', { delimiter: ";" })).toEqual([{ "a,b,c": "1", d: "2" }]);
  });
  it("rejects unsupported currency precision and never rounds source JPY fractions", () => {
    expect(bankStatementAmount("123", "JPY", { decimalSeparator: ".", groupingSeparator: "", minorUnits: 0 }).toJSON().amount).toBe("123.00");
    expect(() => bankStatementAmount("123.01", "JPY", { decimalSeparator: ".", groupingSeparator: "", minorUnits: 0 })).toThrow();
    expect(() => bankStatementAmount("0.001", "KWD", { decimalSeparator: ".", groupingSeparator: "", minorUnits: 3 })).toThrow("invalid_bank_amount_format");
  });
  it("retains an original zero-movement bank export while preserving the shared nonempty-record default", () => {
    expect(parseBankStatementCsv(header, mapping)).toEqual([]);
    expect(() => csvRecords("A,B\n")).toThrow("empty_csv");
    expect(() => parseBankStatementCsv("Wrong;Header\n", mapping)).toThrow("invalid_bank_csv_mapping");
  });
  it("uses the same bank row limit with or without a terminal newline", () => {
    const source = header + Array.from({ length: 5000 }, (_, index) => `03/11/2026;0,01;r${index};item;MAD`).join("\n");
    expect(parseBankStatementCsv(source, mapping)).toHaveLength(5000);
    expect(parseBankStatementCsv(source + "\n", mapping)).toHaveLength(5000);
    expect(() => csvRecords("a\n" + Array.from({ length: 5000 }, () => "b").join("\n"))).toThrow("csv_too_many_rows");
  });
});
