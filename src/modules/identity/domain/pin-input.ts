/** Canonical digits for the existing PIN verifier; other characters remain invalid. */
export function normalizePinInput(value: string): string {
  return value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) - (digit >= "۰" ? 0x6f0 : 0x660)));
}
