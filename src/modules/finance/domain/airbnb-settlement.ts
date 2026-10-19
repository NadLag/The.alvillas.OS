import { parseCsv as parseCsvRecords } from "@/platform/imports/csv";
import Decimal from "decimal.js";
import { z } from "zod";
import {
  assertFinancePostingsBalanced,
  type FinancePostingDraft
} from "@/modules/finance/domain/reservation-revenue";
import { Money } from "@/platform/money/money";

const moneyAmountSchema = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u, "Use a money amount with up to 2 decimals");

const positiveMoneyAmountSchema = moneyAmountSchema.refine(
  (value) => new Decimal(value).gt(0),
  "Amount must be greater than zero"
);

const nonnegativeMoneyAmountSchema = moneyAmountSchema.refine(
  (value) => new Decimal(value).gte(0),
  "Amount must be zero or greater"
);

const requiredText = (max: number) => z.string().trim().min(1).max(max);
const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/u);

export const importAirbnbSettlementCsvInputSchema = z.object({
  csv: z.string().trim().min(1, "CSV is required").max(120_000),
  receivedAccountId: z.string().uuid(),
  idempotencyKey: z.string().uuid()
});

export const reverseAirbnbSettlementInputSchema = z.object({
  settlementId: z.string().uuid(),
  reason: requiredText(1000),
  idempotencyKey: z.string().uuid()
});

const airbnbSettlementCsvRowSchema = z
  .object({
    sourceReservationId: requiredText(120),
    sourcePayoutId: requiredText(120),
    sourceTransactionId: requiredText(120),
    currency: currencySchema,
    grossAmount: positiveMoneyAmountSchema,
    platformFee: nonnegativeMoneyAmountSchema,
    expectedPayout: positiveMoneyAmountSchema,
    actualReceipt: nonnegativeMoneyAmountSchema,
    reason: z.string().trim().max(240).optional(),
    action: z.string().trim().max(240).optional(),
    rowNumber: z.number().int().min(2)
  })
  .superRefine((row, ctx) => {
    const expected = new Decimal(row.expectedPayout);
    const actual = new Decimal(row.actualReceipt);
    if (expected.eq(actual)) {
      return;
    }

    if (!row.reason) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Reason is required when settlement differs"
      });
    }

    if (!row.action) {
      ctx.addIssue({
        code: "custom",
        path: ["action"],
        message: "Action is required when settlement differs"
      });
    }
  });

export type ImportAirbnbSettlementCsvInput = z.infer<typeof importAirbnbSettlementCsvInputSchema>;
export type ReverseAirbnbSettlementInput = z.infer<typeof reverseAirbnbSettlementInputSchema>;
export type AirbnbSettlementCsvRow = z.infer<typeof airbnbSettlementCsvRowSchema>;

export class AirbnbSettlementCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirbnbSettlementCsvError";
  }
}

type CsvRecord = {
  rowNumber: number;
  values: Record<string, string>;
};

type HeaderAlias =
  | "sourceReservationId"
  | "sourcePayoutId"
  | "sourceTransactionId"
  | "currency"
  | "grossAmount"
  | "platformFee"
  | "expectedPayout"
  | "actualReceipt"
  | "reason"
  | "action";

const headerAliases: Record<HeaderAlias, string[]> = {
  sourceReservationId: [
    "source_reservation_id",
    "airbnb_reservation_id",
    "reservation_id",
    "reservation_reference",
    "confirmation_code"
  ],
  sourcePayoutId: ["source_payout_id", "payout_id", "airbnb_payout_id"],
  sourceTransactionId: [
    "source_transaction_id",
    "transaction_id",
    "airbnb_transaction_id",
    "source_id"
  ],
  currency: ["currency"],
  grossAmount: ["gross_amount", "gross"],
  platformFee: ["platform_fee", "airbnb_fee", "fee"],
  expectedPayout: ["expected_payout", "expected"],
  actualReceipt: ["actual_receipt", "actual", "received_amount"],
  reason: ["reason", "variance_reason"],
  action: ["action", "variance_action"]
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function parseCsv(csv: string): string[][] {
  try { return parseCsvRecords(csv); }
  catch (error) { throw new AirbnbSettlementCsvError(error instanceof Error ? error.message : "invalid_csv"); }
}

function csvRecords(csv: string): CsvRecord[] {
  const rows = parseCsv(csv.trim());
  const headerRow = rows[0];

  if (!headerRow) {
    throw new AirbnbSettlementCsvError("CSV must include a header row");
  }

  const headers = headerRow.map(normalizeHeader);
  return rows.slice(1).map((values, index) => ({
    rowNumber: index + 2,
    values: Object.fromEntries(
      headers.map((header, headerIndex) => [header, values[headerIndex]?.trim() ?? ""])
    )
  }));
}

function pick(record: CsvRecord, alias: HeaderAlias): string | undefined {
  for (const header of headerAliases[alias]) {
    const value = record.values[header];
    if (value !== undefined && value !== "") {
      return value;
    }
  }

  return undefined;
}

export function parseAirbnbSettlementCsv(csv: string): AirbnbSettlementCsvRow[] {
  const records = csvRecords(csv);
  if (records.length === 0) {
    throw new AirbnbSettlementCsvError("CSV must include at least one settlement row");
  }

  return records.map((record) => {
    const parsed = airbnbSettlementCsvRowSchema.safeParse({
      sourceReservationId: pick(record, "sourceReservationId"),
      sourcePayoutId: pick(record, "sourcePayoutId"),
      sourceTransactionId: pick(record, "sourceTransactionId"),
      currency: pick(record, "currency"),
      grossAmount: pick(record, "grossAmount"),
      platformFee: pick(record, "platformFee"),
      expectedPayout: pick(record, "expectedPayout"),
      actualReceipt: pick(record, "actualReceipt"),
      reason: pick(record, "reason"),
      action: pick(record, "action"),
      rowNumber: record.rowNumber
    });

    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
        .join("; ");
      throw new AirbnbSettlementCsvError(`CSV row ${record.rowNumber} is invalid: ${message}`);
    }

    return parsed.data;
  });
}

export function parseImportAirbnbSettlementCsvInput(input: unknown) {
  return importAirbnbSettlementCsvInputSchema.safeParse(input);
}

export function parseReverseAirbnbSettlementInput(input: unknown) {
  return reverseAirbnbSettlementInputSchema.safeParse(input);
}

export function settlementVariance(expected: Money, actual: Money): Money {
  expected.subtract(actual);
  return Money.of(expected.amount.minus(actual.amount).abs(), expected.currency);
}

export function buildExpectedAirbnbSettlementPostings(input: {
  otaClearingAccountId: string;
  ownerPayableAccountId: string;
  grossAmount: Money;
  platformFee: Money;
  expectedPayout: Money;
  dimensions: Record<string, unknown>;
}): FinancePostingDraft[] {
  const postings: FinancePostingDraft[] = [
    {
      ledgerAccountId: input.otaClearingAccountId,
      side: "DEBIT",
      amount: input.expectedPayout,
      bucket: "OTA_SETTLEMENT",
      dimensions: {
        ...input.dimensions,
        posting_kind: "airbnb_expected_payout"
      }
    },
    {
      ledgerAccountId: input.ownerPayableAccountId,
      side: "CREDIT",
      amount: input.grossAmount,
      bucket: "OWNER_REVENUE",
      dimensions: {
        ...input.dimensions,
        posting_kind: "airbnb_owner_revenue"
      }
    }
  ];

  if (input.platformFee.amount.gt(0)) {
    postings.splice(1, 0, {
      ledgerAccountId: input.ownerPayableAccountId,
      side: "DEBIT",
      amount: input.platformFee,
      bucket: "OTA_FEE",
      dimensions: {
        ...input.dimensions,
        posting_kind: "airbnb_platform_fee"
      }
    });
  }

  assertFinancePostingsBalanced(postings);
  return postings;
}

export function buildActualAirbnbReceiptPostings(input: {
  receivedAccountId: string;
  otaClearingAccountId: string;
  varianceSuspenseAccountId: string;
  expectedPayout: Money;
  actualReceipt: Money;
  dimensions: Record<string, unknown>;
}): FinancePostingDraft[] {
  const variance = settlementVariance(input.expectedPayout, input.actualReceipt);
  const postings: FinancePostingDraft[] = [];

  if (input.actualReceipt.amount.gt(0)) {
    postings.push({
      ledgerAccountId: input.receivedAccountId,
      side: "DEBIT",
      amount: input.actualReceipt,
      bucket: "OTA_RECEIPT",
      dimensions: {
        ...input.dimensions,
        posting_kind: "airbnb_actual_receipt"
      }
    });
  }

  if (variance.amount.gt(0) && input.actualReceipt.amount.lt(input.expectedPayout.amount)) {
    postings.push({
      ledgerAccountId: input.varianceSuspenseAccountId,
      side: "DEBIT",
      amount: variance,
      bucket: "VARIANCE",
      dimensions: {
        ...input.dimensions,
        posting_kind: "airbnb_settlement_shortfall"
      }
    });
  }

  postings.push({
    ledgerAccountId: input.otaClearingAccountId,
    side: "CREDIT",
    amount: input.expectedPayout,
    bucket: "OTA_SETTLEMENT",
    dimensions: {
      ...input.dimensions,
      posting_kind: "airbnb_clearing_received"
    }
  });

  if (variance.amount.gt(0) && input.actualReceipt.amount.gt(input.expectedPayout.amount)) {
    postings.push({
      ledgerAccountId: input.varianceSuspenseAccountId,
      side: "CREDIT",
      amount: variance,
      bucket: "VARIANCE",
      dimensions: {
        ...input.dimensions,
        posting_kind: "airbnb_settlement_overage"
      }
    });
  }

  assertFinancePostingsBalanced(postings);
  return postings;
}
