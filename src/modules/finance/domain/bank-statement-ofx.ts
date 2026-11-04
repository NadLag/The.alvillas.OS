import { z } from "zod";
import { bankStatementAmount } from "./bank-statement-amount";

type Element = { name: string; text: string; children: Element[] };
export type OfxBankLine = {
  sourceOrder: number;
  externalId: string;
  correction: { externalId: string; action: "REPLACE" | "DELETE" } | null;
  postedDate: string | null;
  sourceTimestamp: string | null;
  amount: { amount: string; currency: string } | null;
  transactionType: string | null;
  name: string | null;
  memo: string | null;
  reference: string | null;
};
export type OfxBankStatement = {
  bankId: string;
  branchId: string | null;
  accountId: string;
  accountType: string;
  currency: string;
  start: string;
  end: string;
  ledgerBalance: { amount: string; currency: string };
  balanceTimestamp: string;
  pendingCount: number;
  lines: OfxBankLine[];
};

function decodeText(value: string): string {
  return value.replace(/&([^;\s&]+);/gu, (_, entity: string) => {
    const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(predefined, entity)) return predefined[entity];
    if (!/^(?:#\d+|#x[\da-fA-F]+)$/u.test(entity)) throw new Error("unsupported_ofx_entity");
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!Number.isSafeInteger(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("invalid_ofx_character");
    return String.fromCodePoint(code);
  });
}

/** Bounded, non-networked OFX grammar. No DTD or external entity resolution. */
function document(source: string): Element {
  if (source.length > 10 * 1024 * 1024 || /<!/u.test(source))
    throw new Error("unsafe_ofx_document");
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) throw new Error("unsafe_ofx_document");
  }
  source = source.replace(/^\uFEFF/u, "");
  const firstTag = source.indexOf("<OFX>");
  if (firstTag < 0) throw new Error("invalid_ofx_document");
  const header = source.slice(0, firstTag).trim();
  const sgml = /^OFXHEADER:100(?:\r?\n|$)/u.test(header);
  if (sgml) {
    const fields = header.split(/\r?\n/u).filter(Boolean).map(line => line.split(":"));
    if (fields.some(field => field.length !== 2) || new Set(fields.map(field => field[0])).size !== fields.length ||
        !fields.some(([key, value]) => key === "DATA" && value === "OFXSGML") ||
        !fields.some(([key, value]) => key === "VERSION" && /^1\d{2}$/u.test(value))) throw new Error("invalid_ofx_header");
  } else if (header && !/^(?:<\?xml\s+[^<>?]*\?>\s*)?(?:<\?OFX\s+[^<>?]*\?>)?$/u.test(header)) throw new Error("invalid_ofx_header");
  const root: Element = { name: "DOCUMENT", text: "", children: [] }, stack = [root];
  const body = source.slice(firstTag), tokens = body.match(/<[^>]*>|[^<]+/gu) ?? [];
  if (tokens.join("") !== body) throw new Error("invalid_ofx_document");
  let nodes = 0;
  for (const token of tokens) {
    if (!token.startsWith("<")) { stack.at(-1)!.text += token; continue; }
    const tag = /^<(\/)?([A-Z][A-Z0-9_.]*)>$/u.exec(token);
    if (!tag) throw new Error("unsupported_ofx_markup");
    const name = tag[2];
    if (sgml && stack.length > 1 && stack.at(-1)!.text.trim() && !stack.at(-1)!.children.length &&
        (!tag[1] || stack.at(-1)!.name !== name)) stack.pop();
    if (tag[1]) {
      if (stack.length < 2 || stack.at(-1)!.name !== name) throw new Error("invalid_ofx_nesting");
      const closing = stack.pop()!;
      if (closing.children.length && closing.text.trim()) throw new Error("invalid_ofx_mixed_content");
    } else {
      if (++nodes > 200000 || stack.length >= 64 || stack.at(-1)!.text.trim()) throw new Error("invalid_ofx_structure");
      const child: Element = { name, text: "", children: [] };
      stack.at(-1)!.children.push(child); stack.push(child);
    }
  }
  if (stack.length !== 1 || root.text.trim() || root.children.length !== 1 || root.children[0].name !== "OFX") throw new Error("invalid_ofx_document");
  return root.children[0];
}

function one(parent: Element, name: string, required = true): Element | null {
  const found = parent.children.filter(child => child.name === name);
  if (found.length > 1 || (required && !found.length)) throw new Error("invalid_ofx_" + name.toLowerCase());
  return found[0] ?? null;
}
function text(parent: Element, name: string, required = true): string | null {
  const child = one(parent, name, required);
  if (!child) return null;
  if (child.children.length || (required && !child.text.trim())) throw new Error("invalid_ofx_" + name.toLowerCase());
  const value = child.text.trim();
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/u.test(value)) throw new Error("invalid_ofx_entity");
  return decodeText(value);
}
function timestamp(source: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.\d{1,3})?)?(?:\s?\[([+-]?\d{1,2}(?:\.\d{1,2})?)(?::[A-Za-z0-9_+ /-]+)?\])?$/u.exec(source);
  if (!match || (match[4] && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 60)) ||
      (match[7] && Math.abs(Number(match[7])) > 12)) throw new Error("invalid_ofx_timestamp");
  return z.iso.date().parse(`${match[1]}-${match[2]}-${match[3]}`);
}
function identifier(value: string): string {
  if (!value || [...value].length > 255) throw new Error("invalid_ofx_fitid");
  return value;
}

/** Imports posted bank facts only. Pending rows and source correction instructions never become ledger entries. */
export function parseBankStatementOfx(source: string, minorUnits: number): OfxBankStatement[] {
  const root = document(source), signon = one(root, "SIGNONMSGSRSV1", false);
  if (signon) {
    const status = one(one(signon, "SONRS")!, "STATUS")!;
    if (text(status, "CODE") !== "0") throw new Error("ofx_signon_failed");
  }
  const banking = one(root, "BANKMSGSRSV1")!;
  const responses = banking.children.filter(child => child.name === "STMTTRNRS");
  if (!responses.length) throw new Error("ofx_bank_statement_required");
  return responses.map(response => {
    if (text(one(response, "STATUS")!, "CODE") !== "0") throw new Error("ofx_statement_failed");
    const statement = one(response, "STMTRS")!, account = one(statement, "BANKACCTFROM")!, transactions = one(statement, "BANKTRANLIST")!;
    const currency = text(statement, "CURDEF")!;
    const amount = (value: string) => bankStatementAmount(value, currency, { decimalSeparator: ".", groupingSeparator: "", minorUnits }).toJSON();
    const start = text(transactions, "DTSTART")!, end = text(transactions, "DTEND")!;
    timestamp(start); timestamp(end);
    const original = transactions.children.filter(child => child.name === "STMTTRN");
    if (original.length > 50000) throw new Error("ofx_too_many_transactions");
    const lines = original.map((line, index): OfxBankLine => {
      if (one(line, "CURRENCY", false) || one(line, "ORIGCURRENCY", false)) throw new Error("ofx_currency_conversion_requires_explicit_policy");
      const corrected = text(line, "CORRECTFITID", false), action = text(line, "CORRECTACTION", false);
      if (!!corrected !== !!action || (action && action !== "REPLACE" && action !== "DELETE")) throw new Error("invalid_ofx_correction");
      const deleting = action === "DELETE";
      const date = text(line, "DTPOSTED", !deleting), rawAmount = text(line, "TRNAMT", !deleting);
      return { sourceOrder: index + 1, externalId: identifier(text(line, "FITID")!),
        correction: corrected ? { externalId: identifier(corrected), action: action as "REPLACE" | "DELETE" } : null,
        postedDate: date ? timestamp(date) : null, sourceTimestamp: date,
        amount: rawAmount ? amount(rawAmount) : null, transactionType: text(line, "TRNTYPE", !deleting),
        name: text(line, "NAME", false), memo: text(line, "MEMO", false), reference: text(line, "REFNUM", false) };
    });
    if (new Set(lines.map(line => line.externalId)).size !== lines.length) throw new Error("duplicate_ofx_fitid_in_account");
    const balance = one(statement, "LEDGERBAL")!, balanceTimestamp = text(balance, "DTASOF")!;
    timestamp(balanceTimestamp);
    return { bankId: text(account, "BANKID")!, branchId: text(account, "BRANCHID", false), accountId: text(account, "ACCTID")!, accountType: text(account, "ACCTTYPE")!,
      currency, start, end, ledgerBalance: amount(text(balance, "BALAMT")!), balanceTimestamp,
      pendingCount: one(statement, "BANKTRANLISTP", false)?.children.filter(child => child.name === "STMTTRNP").length ?? 0, lines };
  });
}
