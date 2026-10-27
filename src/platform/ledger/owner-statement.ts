import Decimal from "decimal.js";
import { z } from "zod";
import { Money } from "@/platform/money/money";

export const ownerStatementBuckets = [
  "OWNER_REVENUE",
  "OWNER_SERVICES",
  "REIMBURSEMENT",
  "COMMISSION",
  "OTA_FEE",
  "OWNER_EXPENSE",
  "PAYOUT",
  "ADJUSTMENT"
] as const;

export type OwnerStatementBucket = (typeof ownerStatementBuckets)[number];

export type RawOwnerLedgerPosting = {
  id: string;
  transactionId: string;
  reference: string;
  occurredAt: Date;
  description: string | null;
  side: "DEBIT" | "CREDIT";
  amount: string;
  currency: string;
  bucket: string | null;
  dimensions: Record<string, unknown> | null;
  locationName: string | null;
  locationCode: string | null;
  propertyName?: string | null;
};

export type OwnerStatementLine = {
  postingId: string;
  transactionId: string;
  reference: string;
  occurredAt: Date;
  description: string | null;
  bucket: OwnerStatementBucket;
  side: "DEBIT" | "CREDIT";
  amount: Money;
  signedAmount: Money;
  locationName: string;
  reservationReference: string | null;
  source: string | null;
  propertyId: string | null;
  propertyName: string | null;
  category: string | null;
  runningBalance: Money;
};

export type OwnerHeldBreakdown = {
  locationName: string;
  amount: Money;
};

export type OwnerStatement<TPropertyId extends string | null = string> = {
  organizationId: string;
  ownerId: string;
  ownerName: string;
  propertyId: TPropertyId;
  propertyName: TPropertyId extends null ? null : string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  openingBalance: Money;
  periodCreditTotal: Money;
  periodDebitTotal: Money;
  closingBalance: Money;
  bucketTotals: Record<OwnerStatementBucket, Money>;
  bucketMovements: Record<OwnerStatementBucket, { credits: Money; debits: Money }>;
  heldBreakdown: OwnerHeldBreakdown[];
  lines: OwnerStatementLine[];
};

export const statementPeriodInputSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)
  })
  .refine((value) => value.from <= value.to, {
    message: "Statement period end must be on or after the start date",
    path: ["to"]
  });

export type StatementPeriodInput = z.infer<typeof statementPeriodInputSchema>;

export function dateOnlyToUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function defaultStatementPeriod(now = new Date()): StatementPeriodInput {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 0));

  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10)
  };
}

export function statementPeriodDates(input: StatementPeriodInput): {
  periodStart: Date;
  periodEnd: Date;
} {
  const parsed = statementPeriodInputSchema.parse(input);
  const periodStart = dateOnlyToUtc(parsed.from);
  const periodEnd = addUtcDays(dateOnlyToUtc(parsed.to), 1);

  return { periodStart, periodEnd };
}

function emptyBucketTotals(currency: string): Record<OwnerStatementBucket, Money> {
  return Object.fromEntries(
    ownerStatementBuckets.map((bucket) => [bucket, Money.zero(currency)])
  ) as Record<OwnerStatementBucket, Money>;
}

function normalizeBucket(bucket: string | null): OwnerStatementBucket {
  if (ownerStatementBuckets.includes(bucket as OwnerStatementBucket)) {
    return bucket as OwnerStatementBucket;
  }

  throw new Error(`Owner statement posting has unsupported bucket: ${bucket ?? "null"}`);
}

function postingMoney(posting: RawOwnerLedgerPosting): Money {
  return Money.of(posting.amount, posting.currency);
}

function signedPostingMoney(posting: RawOwnerLedgerPosting): Money {
  const amount = new Decimal(posting.amount);
  return Money.of(posting.side === "CREDIT" ? amount : amount.negated(), posting.currency);
}

function dimensionString(
  dimensions: Record<string, unknown> | null,
  key: string
): string | null {
  const value = dimensions?.[key];
  return typeof value === "string" ? value : null;
}

function assertSingleCurrency(postings: readonly RawOwnerLedgerPosting[], fallbackCurrency: string): string {
  const currencies = new Set(postings.map((posting) => posting.currency));

  if (currencies.size > 1) {
    throw new Error("Owner statement cannot mix currencies");
  }

  return [...currencies][0] ?? fallbackCurrency;
}

function addToMap(map: Map<string, Money>, key: string, amount: Money): void {
  map.set(key, (map.get(key) ?? Money.zero(amount.currency)).add(amount));
}

export function buildOwnerStatement<TPropertyId extends string | null>(input: {
  organizationId: string;
  ownerId: string;
  ownerName: string;
  propertyId: TPropertyId;
  propertyName: TPropertyId extends null ? null : string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  postings: readonly RawOwnerLedgerPosting[];
}): OwnerStatement<TPropertyId> {
  const currency = assertSingleCurrency(input.postings, input.currency);
  let openingBalance = Money.zero(currency);
  let periodCreditTotal = Money.zero(currency);
  let periodDebitTotal = Money.zero(currency);
  const bucketTotals = emptyBucketTotals(currency);
  const bucketMovements = Object.fromEntries(ownerStatementBuckets.map(bucket => [bucket, { credits: Money.zero(currency), debits: Money.zero(currency) }])) as OwnerStatement<TPropertyId>["bucketMovements"];
  const heldByLocation = new Map<string, Money>();
  const lines: OwnerStatementLine[] = [];

  // Keep database microsecond ordering when JavaScript dates share a millisecond.
  const ordered = input.postings.map((posting, index) => ({ posting, index })).sort((a, b) => a.posting.occurredAt.getTime() - b.posting.occurredAt.getTime() || a.index - b.index);
  for (const { posting } of ordered) {
    const amount = postingMoney(posting);
    const signedAmount = signedPostingMoney(posting);
    const bucket = normalizeBucket(posting.bucket);
    const locationName = posting.locationName ?? "UNALLOCATED";

    if (posting.occurredAt < input.periodStart) {
      openingBalance = openingBalance.add(signedAmount);
    }

    if (posting.occurredAt < input.periodEnd) {
      addToMap(heldByLocation, locationName, signedAmount);
    }

    if (posting.occurredAt >= input.periodStart && posting.occurredAt < input.periodEnd) {
      if (posting.side === "CREDIT") {
        periodCreditTotal = periodCreditTotal.add(amount);
        bucketMovements[bucket].credits = bucketMovements[bucket].credits.add(amount);
      } else {
        periodDebitTotal = periodDebitTotal.add(amount);
        bucketMovements[bucket].debits = bucketMovements[bucket].debits.add(amount);
      }

      bucketTotals[bucket] = bucketTotals[bucket].add(signedAmount);
      lines.push({
        postingId: posting.id,
        transactionId: posting.transactionId,
        reference: posting.reference,
        occurredAt: posting.occurredAt,
        description: posting.description,
        bucket,
        side: posting.side,
        amount,
        signedAmount,
        locationName,
        reservationReference: dimensionString(posting.dimensions, "reservation_reference"),
        source: dimensionString(posting.dimensions, "source"),
        propertyId: dimensionString(posting.dimensions, "property_id"),
        propertyName: posting.propertyName ?? null,
        category: dimensionString(posting.dimensions, "category"),
        runningBalance: openingBalance.add(periodCreditTotal).subtract(periodDebitTotal)
      });
    }
  }

  return {
    organizationId: input.organizationId,
    ownerId: input.ownerId,
    ownerName: input.ownerName,
    propertyId: input.propertyId,
    propertyName: input.propertyName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency,
    openingBalance,
    periodCreditTotal,
    periodDebitTotal,
    closingBalance: openingBalance.add(periodCreditTotal).subtract(periodDebitTotal),
    bucketTotals,
    bucketMovements,
    heldBreakdown: [...heldByLocation.entries()]
      .map(([locationName, amount]) => ({ locationName, amount }))
      .filter((entry) => !entry.amount.amount.eq(0))
      .sort((a, b) => a.locationName.localeCompare(b.locationName)),
    lines
  };
}
