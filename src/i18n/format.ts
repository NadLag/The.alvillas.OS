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

/** Recipe requirements retain all six decimal digits even when their integer
 * totals exceed a safe JS number. BigInt formats each digit without rounding. */
export function formatRecipeQuantity(locale:AppLocale,value:string):string{
  if(value.length>100||!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value))throw new RangeError("Exact recipe quantity required");
  const [whole,fraction]=value.split("."),integer=new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(BigInt(whole));
  if(!fraction)return integer;
  const separator=new Intl.NumberFormat(locale).formatToParts(1.1).find(part=>part.type==="decimal")!.value;
  return integer+separator+new Intl.NumberFormat(locale,{useGrouping:false,minimumIntegerDigits:fraction.length}).format(BigInt(fraction));
}

export function formatCurrency(locale: AppLocale, money: Money): string {
  return formatCurrencyAmount(locale, money.amount, money.currency);
}

/** Percentage points expressed at one decimal, formatted without a Number
 * conversion even when the original amounts exceed a safe integer. */
export function formatPercentageAmount(locale:AppLocale,value:string):string{
  if(!/^-?(?:0|[1-9]\d*)\.\d$/u.test(value))throw new RangeError("Exact percentage required");
  const negative=value.startsWith("-"),digits=value.replace(/[-.]/gu,"").padStart(4,"0");
  const ratio=(negative?"-":"")+digits.slice(0,-3)+"."+digits.slice(-3);
  const formatter=new Intl.NumberFormat(locale,{style:"percent",minimumFractionDigits:1,maximumFractionDigits:1,signDisplay:"exceptZero"});
  return (formatter.format.bind(formatter) as (value:number|bigint|string)=>string)(ratio);
}

export function formatCurrencyAmount(
  locale: AppLocale,
  amount: DecimalInput,
  currency: string
): string {
  const decimal = new Decimal(amount);
  if (!decimal.isFinite()) throw new Error("Cannot format a non-finite number");
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "code",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  // ECMA-402 ToIntlMathematicalValue preserves a decimal string's exact value.
  // TypeScript's NumberFormat declaration still omits this supported input.
  const formatDecimal = formatter.format.bind(formatter) as (value: number | bigint | string) => string;
  return formatDecimal(decimal.toFixed());
}

export function pluralCategory(locale: AppLocale, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(count);
}
