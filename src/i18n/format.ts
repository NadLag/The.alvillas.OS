import Decimal from "decimal.js";
import type { Money } from "@/platform/money/money";
import type { AppLocale } from "@/i18n/routing";

const defaultTimeZone = "Africa/Casablanca";

/** Canonical calendar date for a configured IANA zone; independent of display locale. */
export function calendarDateAt(value: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(value).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

type DecimalInput = string | Decimal;

function decimalToSafeNumber(value: DecimalInput): number {
  const decimal = new Decimal(value);

  if (!decimal.isFinite()) {
    throw new Error("Cannot format a non-finite number");
  }

  if (decimal.abs().greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Cannot format a number larger than Number.MAX_SAFE_INTEGER");
  }

  return decimal.toNumber();
}

export function formatDate(
  locale: AppLocale,
  value: Date,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: defaultTimeZone,
    ...options
  }).format(value);
}

export function formatDateTime(
  locale: AppLocale,
  value: Date,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: defaultTimeZone,
    ...options
  }).format(value);
}

export function formatNumber(
  locale: AppLocale,
  value: DecimalInput,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, options).format(decimalToSafeNumber(value));
}

export function formatCurrency(locale: AppLocale, money: Money): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(decimalToSafeNumber(money.amount));
}

export function formatCurrencyAmount(
  locale: AppLocale,
  amount: DecimalInput,
  currency: string
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(decimalToSafeNumber(amount));
}

export function pluralCategory(locale: AppLocale, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(count);
}
