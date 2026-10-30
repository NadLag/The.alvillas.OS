/** Normalize decimal input characters without converting an exact monetary amount to a number. */
export function normalizeAmountInput(value: string): string {
  return value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)))
    .replace(/[٫,]/gu, ".").replace(/^0+(?=\d)/u, "");
}
