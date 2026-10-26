import { describe, expect, it } from "vitest";
import { Money } from "@/platform/money/money";
import { formatCurrency, formatCurrencyAmount } from "@/i18n/format";

const values = ["90071992547409.91", "9007199254740991.99"] as const;
const expected = {
  en: ["MAD\u00a090,071,992,547,409.91", "MAD\u00a09,007,199,254,740,991.99"],
  fr: ["90\u202f071\u202f992\u202f547\u202f409,91\u00a0MAD", "9\u202f007\u202f199\u202f254\u202f740\u202f991,99\u00a0MAD"],
  ar: ["\u200f90,071,992,547,409.91\u00a0MAD", "\u200f9,007,199,254,740,991.99\u00a0MAD"],
};
describe("currency display preserves exact ledger cents", () => {
  for (const locale of ["en", "fr", "ar"] as const) for (const [index, amount] of values.entries()) {
    it(`formats Money ${amount} exactly in ${locale}`, () => expect(formatCurrency(locale, Money.of(amount, "MAD"))).toBe(expected[locale][index]));
    it(`formats decimal ledger amount ${amount} exactly in ${locale}`, () => expect(formatCurrencyAmount(locale, amount, "MAD")).toBe(expected[locale][index]));
  }
});
