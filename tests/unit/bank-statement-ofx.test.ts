import { describe, expect, it } from "vitest";
import { parseBankStatementOfx } from "@/modules/finance/domain/bank-statement-ofx";

const transaction = (id = "bank-original-1", extra = "") => `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261103235959.123[+1:CET]</DTPOSTED><TRNAMT>-0.01</TRNAMT><FITID>${id}</FITID><NAME>Virement &amp; dépôt</NAME>${extra}</STMTTRN>`;
const statement = (rows = transaction(), account = "original-account") => `<STMTTRNRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>MAD</CURDEF><BANKACCTFROM><BANKID>original-bank</BANKID><ACCTID>${account}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20261101</DTSTART><DTEND>20261201</DTEND>${rows}</BANKTRANLIST><LEDGERBAL><BALAMT>9999999999999999.99</BALAMT><DTASOF>20261104000000</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS>`;
const file = (body = statement()) => `<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="230" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n<OFX><BANKMSGSRSV1>${body}</BANKMSGSRSV1></OFX>`;
describe("OFX banking source evidence", () => {
  it("retains exact signed amounts, bank-local dates, original timestamps and account-scoped identity", () => {
    const [result] = parseBankStatementOfx(file(), 2);
    expect(result).toMatchObject({ bankId: "original-bank", accountId: "original-account", currency: "MAD", ledgerBalance: { amount: "9999999999999999.99", currency: "MAD" } });
    expect(result.lines[0]).toMatchObject({ externalId: "bank-original-1", postedDate: "2026-11-03", sourceTimestamp: "20261103235959.123[+1:CET]", amount: { amount: "-0.01", currency: "MAD" }, name: "Virement & dépôt", correction: null });
  });
  it("reads OFX 1.x implicit leaf endings without accepting malformed XML 2.x", () => {
    const body = `<OFX><BANKMSGSRSV1>${statement()}</BANKMSGSRSV1></OFX>`;
    const implicit = body.replace(/<(CODE|SEVERITY|CURDEF|BANKID|ACCTID|ACCTTYPE|DTSTART|DTEND|TRNTYPE|DTPOSTED|TRNAMT|FITID|NAME|BALAMT|DTASOF)>([^<]*)<\/\1>/gu, "<$1>$2\n");
    expect(parseBankStatementOfx("OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\n\n" + implicit, 2)[0].lines[0].amount?.amount).toBe("-0.01");
    expect(() => parseBankStatementOfx(implicit, 2)).toThrow();
  });
  it("keeps bank corrections as append-only source instructions", () => {
    const rows = transaction("replacement", "<CORRECTFITID>earlier</CORRECTFITID><CORRECTACTION>REPLACE</CORRECTACTION>") + '<STMTTRN><FITID>deletion</FITID><CORRECTFITID>replacement</CORRECTFITID><CORRECTACTION>DELETE</CORRECTACTION></STMTTRN>';
    expect(parseBankStatementOfx(file(statement(rows)), 2)[0].lines.map(line => ({ correction: line.correction, amount: line.amount?.amount ?? null }))).toEqual([
      { correction: { externalId: "earlier", action: "REPLACE" }, amount: "-0.01" }, { correction: { externalId: "replacement", action: "DELETE" }, amount: null }]);
  });
  it("allows the same FITID in different actual accounts, with the full 255-character identifier", () => {
    expect(parseBankStatementOfx(file(statement(transaction("x".repeat(255)), "a") + statement(transaction("x".repeat(255)), "b")), 2)).toHaveLength(2);
    expect(() => parseBankStatementOfx(file(statement(transaction("x".repeat(256)))), 2)).toThrow("invalid_ofx_fitid");
    expect(() => parseBankStatementOfx(file(statement(transaction() + transaction())), 2)).toThrow("duplicate_ofx_fitid_in_account");
  });
  it("does not change amount sign based on transaction type", () => {
    expect(parseBankStatementOfx(file().replace("<TRNAMT>-0.01", "<TRNAMT>0.01"), 2)[0].lines[0].amount?.amount).toBe("0.01");
  });
  it("counts pending facts separately without importing them as posted transactions", () => {
    const source = file().replace("</STMTRS>", "<BANKTRANLISTP><DTASOF>20261103</DTASOF><STMTTRNP><TRNAMT>12.00</TRNAMT></STMTTRNP></BANKTRANLISTP></STMTRS>");
    const result = parseBankStatementOfx(source, 2)[0];
    expect(result.pendingCount).toBe(1); expect(result.lines).toHaveLength(1);
  });
  it.each(["<!DOCTYPE OFX SYSTEM 'https://foreign.test/evil'>", "<!ENTITY evil SYSTEM 'file:///private'>", "<!-- untrusted extension -->"])("rejects XML extensions without expansion or network access %s", extension => {
    expect(() => parseBankStatementOfx(extension + file(), 2)).toThrow("unsafe_ofx_document");
  });
  it.each(["20260229000000", "20261103240000", "20261103006000", "20261103000061", "20261103000000[13:BAD]", "not-a-date"])("rejects invalid date/time %s", value => {
    expect(() => parseBankStatementOfx(file().replace("20261103235959.123[+1:CET]", value), 2)).toThrow();
  });
  it.each(["<CORRECTFITID>old</CORRECTFITID>", "<CORRECTACTION>REPLACE</CORRECTACTION>", "<CORRECTFITID>old</CORRECTFITID><CORRECTACTION>UPDATE</CORRECTACTION>"])("rejects incomplete or unknown correction %s", correction => {
    expect(() => parseBankStatementOfx(file(statement(transaction("new", correction))), 2)).toThrow("invalid_ofx_correction");
  });
  it.each(["<FITID>another</FITID>", "<TRNAMT>1.00</TRNAMT>", "<CURRENCY><CURSYM>EUR</CURSYM></CURRENCY>"])("rejects ambiguous fields and currency conversion %s", extra => {
    expect(() => parseBankStatementOfx(file(statement(transaction("original", extra))), 2)).toThrow();
  });
  it("rejects unsafe text, unknown entities, excess precision, failed responses and crossed accounts", () => {
    for (const source of [file().replace("&amp;", "&external;"), file().replace("-0.01", "-0.001"), file().replace("<CODE>0", "<CODE>2005"), file().replace("<BANKACCTFROM>", "<BANKACCTFROM injected='1'>"), file() + "<OFX></OFX>", file() + "<", file().replace("</BANKACCTFROM>", "</STMTRS>")]) expect(() => parseBankStatementOfx(source, 2)).toThrow();
  });
  it("accepts a valid leap day and retains a leap second as source evidence", () => {
    expect(parseBankStatementOfx(file().replace("20261103235959.123[+1:CET]", "20240229235960[0:GMT]"), 2)[0].lines[0].postedDate).toBe("2024-02-29");
  });
});
