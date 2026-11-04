import { Money } from "@/platform/money/money";

export type BankAmountFormat = {
  decimalSeparator: "." | ",";
  groupingSeparator: "" | "." | "," | " " | "\u00a0" | "\u202f";
  minorUnits: number;
};

/** A source amount is evidence. Reject unsupported precision instead of rounding it. */
export function bankStatementAmount(source: string, currency: string, format: BankAmountFormat): Money {
  if (!Number.isInteger(format.minorUnits) || format.minorUnits < 0 || format.minorUnits > 2 ||
      format.decimalSeparator === format.groupingSeparator) throw new Error("invalid_bank_amount_format");
  const value = source.trim();
  const sign = /^[+-]/u.test(value) ? value[0] : "";
  const unsigned = sign ? value.slice(1) : value;
  const parts = unsigned.split(format.decimalSeparator);
  if (parts.length > 2 || !parts[0] || (parts.length === 2 && !parts[1])) throw new Error("invalid_bank_amount");
  const groups = format.groupingSeparator ? parts[0].split(format.groupingSeparator) : [parts[0]];
  if (groups.some(group => !/^\d+$/u.test(group)) ||
      (groups.length > 1 && (!/^\d{1,3}$/u.test(groups[0]) || groups.slice(1).some(group => !/^\d{3}$/u.test(group)))))
    throw new Error("invalid_bank_amount_grouping");
  const fraction = parts[1] ?? "";
  if (!/^\d*$/u.test(fraction) || fraction.length > format.minorUnits) throw new Error("invalid_bank_amount_precision");
  return Money.of(`${sign}${groups.join("")}${fraction ? "." + fraction : ""}`, currency);
}
