import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import {
  buildActualAirbnbReceiptPostings,
  buildExpectedAirbnbSettlementPostings,
  parseAirbnbSettlementCsv,
  parseImportAirbnbSettlementCsvInput,
  parseReverseAirbnbSettlementInput,
  settlementVariance,
  type AirbnbSettlementCsvRow,
  type ImportAirbnbSettlementCsvInput,
  type ReverseAirbnbSettlementInput
} from "@/modules/finance/domain/airbnb-settlement";
import {
  FinanceRepository,
  type FinanceLedgerAccount,
  type PostingTransaction
} from "@/modules/finance/infrastructure/finance-repository";
import {
  assertFinancePostingsBalanced,
  type FinancePostingDraft
} from "@/modules/finance/domain/reservation-revenue";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type Action, type AuthContext } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { matchesFinancialReversalAttempt } from "../domain/financial-reversal";
import { reverseAirbnbSettlementInputSchema } from "../domain/airbnb-settlement";

const airbnbSettlementSourceType = "AIRBNB_SETTLEMENT";

export class AirbnbSettlementAuthorizationError extends Error {
  constructor(message = "Airbnb settlement action is not authorized") {
    super(message);
    this.name = "AirbnbSettlementAuthorizationError";
  }
}

export class AirbnbSettlementNotFoundError extends Error {
  constructor(message = "Airbnb settlement resource was not found") {
    super(message);
    this.name = "AirbnbSettlementNotFoundError";
  }
}

export class AirbnbSettlementConfigError extends Error {
  constructor(message = "Airbnb settlement configuration is missing or invalid") {
    super(message);
    this.name = "AirbnbSettlementConfigError";
  }
}

export class AirbnbSettlementConflictError extends Error {
  constructor(message = "Airbnb settlement has already been posted") {
    super(message);
    this.name = "AirbnbSettlementConflictError";
  }
}

type AirbnbSettlementServiceDeps = {
  db?: TenantTransactionRunner;
  requestId?: string;
  ipAddress?: string | null;
};

type AuditMeta = {
  requestId: string;
  ipAddress: string | null;
};

type FinanceActorContext = {
  organizationId: string;
  actorId: string;
  authContext: AuthContext;
};

type MatchedAirbnbReservation = {
  id: string;
  reference: string;
  source: string;
  externalId: string | null;
  propertyId: string;
  propertyName: string;
};

export type AirbnbSettlementImportItem = {
  settlementId: string;
  reservationId: string;
  propertyId: string;
  sourceTransactionId: string;
  expectedTransactionId: string;
  receiptTransactionId: string;
  expectedPayout: Money;
  actualReceipt: Money;
  varianceAmount: Money;
  varianceId: string | null;
  idempotent: boolean;
};

export type AirbnbSettlementImportResult = {
  imported: AirbnbSettlementImportItem[];
};

export type AirbnbSettlementVarianceSummary = {
  id: string;
  settlementId: string;
  reservationId: string | null;
  reservationReference: string | null;
  propertyId: string | null;
  propertyName: string | null;
  sourceReservationId: string | null;
  sourcePayoutId: string | null;
  sourceTransactionId: string | null;
  expectedAmount: Money;
  actualAmount: Money;
  varianceAmount: Money;
  reason: string;
  action: string;
  status: string;
  createdAt: Date;
};

export type AirbnbSettlementReversalResult = {
  settlementId: string;
  reversalTransactionIds: string[];
  idempotent: boolean;
};

function db(deps: AirbnbSettlementServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

async function auditMeta(deps: AirbnbSettlementServiceDeps): Promise<AuditMeta> {
  if (deps.requestId) {
    return {
      requestId: deps.requestId,
      ipAddress: deps.ipAddress ?? null
    };
  }

  const requestHeaders = await headers();

  return {
    requestId: requestHeaders.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  };
}

function assertAllowed(
  ctx: FinanceActorContext,
  action: Action,
  resource: "reservation" | "financial_transaction",
  id?: string
): void {
  const allowed = authorize(ctx.authContext, action, {
    type: resource,
    organizationId: ctx.organizationId,
    id,
    dataClass: resource === "financial_transaction" ? "financial" : "operational"
  });

  if (!allowed) {
    throw new AirbnbSettlementAuthorizationError();
  }
}

function toAuditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function assertLedgerAccount(
  account: FinanceLedgerAccount,
  expected: {
    accountType: string;
    normalSide: "DEBIT" | "CREDIT";
  }
): void {
  if (account.archivedAt) {
    throw new AirbnbSettlementConfigError("Ledger account is archived");
  }

  if (account.accountType !== expected.accountType || account.normalSide !== expected.normalSide) {
    throw new AirbnbSettlementConfigError("Ledger account type is invalid");
  }
}

function rowMoney(row: AirbnbSettlementCsvRow): {
  grossAmount: Money;
  platformFee: Money;
  expectedPayout: Money;
  actualReceipt: Money;
  varianceAmount: Money;
} {
  const grossAmount = Money.of(row.grossAmount, row.currency);
  const platformFee = Money.of(row.platformFee, row.currency);
  const expectedPayout = Money.of(row.expectedPayout, row.currency);
  const actualReceipt = Money.of(row.actualReceipt, row.currency);

  return {
    grossAmount,
    platformFee,
    expectedPayout,
    actualReceipt,
    varianceAmount: settlementVariance(expectedPayout, actualReceipt)
  };
}

function transactionKeys(sourceTransactionId: string): {
  settlementKey: string;
  expectedKey: string;
  receiptKey: string;
} {
  return {
    settlementKey: `airbnb-settlement:${sourceTransactionId}`,
    expectedKey: `airbnb-settlement:${sourceTransactionId}:expected`,
    receiptKey: `airbnb-settlement:${sourceTransactionId}:receipt`
  };
}

function dimensions(input: {
  settlementId: string;
  reservation: MatchedAirbnbReservation;
  row: AirbnbSettlementCsvRow;
}): Record<string, unknown> {
  return {
    airbnb_settlement_id: input.settlementId,
    reservation_id: input.reservation.id,
    reservation_reference: input.reservation.reference,
    property_id: input.reservation.propertyId,
    source: "AIRBNB",
    source_reservation_id: input.row.sourceReservationId,
    source_payout_id: input.row.sourcePayoutId,
    source_transaction_id: input.row.sourceTransactionId
  };
}

function assertSameImportedSettlement(
  existing: {
    sourceReservationId: string;
    sourcePayoutId: string;
    sourceTransactionId: string;
    currency: string;
    grossAmount: Prisma.Decimal;
    platformFee: Prisma.Decimal;
    expectedPayout: Prisma.Decimal;
    actualReceipt: Prisma.Decimal;
  },
  row: AirbnbSettlementCsvRow
): void {
  const same =
    existing.sourceReservationId === row.sourceReservationId &&
    existing.sourcePayoutId === row.sourcePayoutId &&
    existing.sourceTransactionId === row.sourceTransactionId &&
    existing.currency === row.currency &&
    existing.grossAmount.toString() === Money.of(row.grossAmount, row.currency).amount.toString() &&
    existing.platformFee.toString() === Money.of(row.platformFee, row.currency).amount.toString() &&
    existing.expectedPayout.toString() === Money.of(row.expectedPayout, row.currency).amount.toString() &&
    existing.actualReceipt.toString() === Money.of(row.actualReceipt, row.currency).amount.toString();

  if (!same) {
    throw new AirbnbSettlementConflictError("Airbnb source transaction was already imported differently");
  }
}

function idempotentSettlementResult(input: {
  settlementId: string;
  reservationId: string;
  propertyId: string;
  sourceTransactionId: string;
  row: AirbnbSettlementCsvRow;
  transactions: readonly PostingTransaction[];
}): AirbnbSettlementImportItem {
  const amounts = rowMoney(input.row);
  const expected = input.transactions.find((transaction) =>
    transaction.postings.some((posting) => posting.bucket === "OWNER_REVENUE")
  );
  const receipt = input.transactions.find((transaction) =>
    transaction.postings.some((posting) => posting.bucket === "OTA_RECEIPT")
  );
  const variancePosting = input.transactions
    .flatMap((transaction) => transaction.postings)
    .find((posting) => posting.bucket === "VARIANCE");

  return {
    settlementId: input.settlementId,
    reservationId: input.reservationId,
    propertyId: input.propertyId,
    sourceTransactionId: input.sourceTransactionId,
    expectedTransactionId: expected?.id ?? "",
    receiptTransactionId: receipt?.id ?? "",
    expectedPayout: amounts.expectedPayout,
    actualReceipt: amounts.actualReceipt,
    varianceAmount: amounts.varianceAmount,
    varianceId: variancePosting ? null : null,
    idempotent: true
  };
}

function mirrorPostings(
  original: PostingTransaction,
  settlementId: string
): FinancePostingDraft[] {
  return original.postings.map((posting) => ({
    ledgerAccountId: posting.ledgerAccountId,
    side: posting.side === "DEBIT" ? "CREDIT" : "DEBIT",
    amount: Money.of(posting.amount.toString(), posting.currency),
    bucket: posting.bucket,
    dimensions: {
      ...jsonObject(posting.dimensions),
      airbnb_settlement_id: settlementId,
      posting_kind: "airbnb_settlement_reversal",
      reversal_of_transaction_id: original.id
    }
  }));
}

export function parseAirbnbSettlementImportInput(input: unknown) {
  return parseImportAirbnbSettlementCsvInput(input);
}

export function parseAirbnbSettlementReversalInput(input: unknown) {
  return parseReverseAirbnbSettlementInput(input);
}

export async function importAirbnbSettlementCsv(
  ctx: FinanceActorContext,
  input: ImportAirbnbSettlementCsvInput,
  deps: AirbnbSettlementServiceDeps = {}
): Promise<AirbnbSettlementImportResult> {
  assertAllowed(ctx, "view", "reservation");
  assertAllowed(ctx, "view", "financial_transaction");
  assertAllowed(ctx, "create", "financial_transaction");
  assertAllowed(ctx, "reconcile", "financial_transaction");
  const rows = parseAirbnbSettlementCsv(input.csv);
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new FinanceRepository(tx, ctx.organizationId);
    const [baseCurrency, receivedAccount] = await Promise.all([
      repository.findOrganizationBaseCurrency(),
      repository.findLedgerAccountById(input.receivedAccountId)
    ]);

    if (!receivedAccount) {
      throw new AirbnbSettlementNotFoundError("Receiving account does not exist in this tenant");
    }

    assertLedgerAccount(receivedAccount, {
      accountType: "ASSET_LOCATION",
      normalSide: "DEBIT"
    });

    const [otaClearing, ownerPayable, varianceSuspense] = await Promise.all([
      repository.ensureLedgerAccount({
        code: "OTA_CLEARING_AIRBNB",
        name: "Airbnb clearing",
        accountType: "ASSET_LOCATION",
        normalSide: "DEBIT"
      }),
      repository.ensureLedgerAccount({
        code: "OWNER_PAYABLE",
        name: "Owner payable",
        accountType: "CLAIM_OWNERSHIP",
        normalSide: "CREDIT"
      }),
      repository.ensureLedgerAccount({
        code: "VARIANCE_SUSPENSE",
        name: "Variance suspense",
        accountType: "SUSPENSE",
        normalSide: "DEBIT"
      })
    ]);

    const imported: AirbnbSettlementImportItem[] = [];

    for (const row of rows) {
      if (row.currency !== baseCurrency) {
        throw new AirbnbSettlementConfigError("Settlement currency must match the organization base currency");
      }

      const reservation = await repository.findAirbnbReservationBySourceIdentifier(
        row.sourceReservationId
      );
      if (!reservation) {
        throw new AirbnbSettlementNotFoundError("Airbnb reservation source identifier was not matched");
      }

      const keys = transactionKeys(row.sourceTransactionId);
      const existing = await repository.findAirbnbSettlementBySourceTransactionId(row.sourceTransactionId);
      if (existing) {
        assertSameImportedSettlement(existing, row);
        const transactions = await repository.findPostingTransactionsForAirbnbSettlement(existing.id);
        imported.push(
          idempotentSettlementResult({
            settlementId: existing.id,
            reservationId: existing.reservationId,
            propertyId: existing.propertyId,
            sourceTransactionId: existing.sourceTransactionId,
            row,
            transactions
          })
        );
        continue;
      }

      const amounts = rowMoney(row);
      const settlement = await repository.createAirbnbSettlement({
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        sourceReservationId: row.sourceReservationId,
        sourcePayoutId: row.sourcePayoutId,
        sourceTransactionId: row.sourceTransactionId,
        currency: row.currency,
        grossAmount: amounts.grossAmount.toJSON().amount,
        platformFee: amounts.platformFee.toJSON().amount,
        expectedPayout: amounts.expectedPayout.toJSON().amount,
        actualReceipt: amounts.actualReceipt.toJSON().amount,
        idempotencyKey: `${input.idempotencyKey}:${keys.settlementKey}`,
        importedBy: ctx.actorId
      });
      const postingDimensions = dimensions({ settlementId: settlement.id, reservation, row });
      const expectedPostings = buildExpectedAirbnbSettlementPostings({
        otaClearingAccountId: otaClearing.id,
        ownerPayableAccountId: ownerPayable.id,
        grossAmount: amounts.grossAmount,
        platformFee: amounts.platformFee,
        expectedPayout: amounts.expectedPayout,
        dimensions: postingDimensions
      });
      const expectedTransaction = await repository.createFinancialTransaction({
        reference: `${reservation.reference}:AIRBNB_EXPECTED:${row.sourceTransactionId}`,
        occurredAt: new Date(),
        description: `Airbnb expected payout for ${reservation.reference}`,
        idempotencyKey: keys.expectedKey,
        createdBy: ctx.actorId,
        postings: expectedPostings
      });
      const receiptPostings = buildActualAirbnbReceiptPostings({
        receivedAccountId: receivedAccount.id,
        otaClearingAccountId: otaClearing.id,
        varianceSuspenseAccountId: varianceSuspense.id,
        expectedPayout: amounts.expectedPayout,
        actualReceipt: amounts.actualReceipt,
        dimensions: postingDimensions
      });
      const receiptTransaction = await repository.createFinancialTransaction({
        reference: `${reservation.reference}:AIRBNB_RECEIPT:${row.sourceTransactionId}`,
        occurredAt: new Date(),
        description: `Airbnb actual receipt for ${reservation.reference}`,
        idempotencyKey: keys.receiptKey,
        createdBy: ctx.actorId,
        postings: receiptPostings
      });

      let varianceId: string | null = null;
      if (amounts.varianceAmount.amount.gt(0)) {
        const variance = await repository.createVariance({
          sourceType: airbnbSettlementSourceType,
          sourceId: settlement.id,
          propertyId: reservation.propertyId,
          reservationId: reservation.id,
          expectedAmount: amounts.expectedPayout.toJSON().amount,
          actualAmount: amounts.actualReceipt.toJSON().amount,
          varianceAmount: amounts.varianceAmount.toJSON().amount,
          currency: row.currency,
          reason: row.reason ?? "",
          action: row.action ?? "",
          createdBy: ctx.actorId
        });
        varianceId = variance.id;
      }

      const result: AirbnbSettlementImportItem = {
        settlementId: settlement.id,
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        sourceTransactionId: row.sourceTransactionId,
        expectedTransactionId: expectedTransaction.id,
        receiptTransactionId: receiptTransaction.id,
        expectedPayout: amounts.expectedPayout,
        actualReceipt: amounts.actualReceipt,
        varianceAmount: amounts.varianceAmount,
        varianceId,
        idempotent: false
      };

      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorId: ctx.actorId,
        action: "airbnb.settlement.imported",
        resourceType: "airbnb_settlement",
        resourceId: settlement.id,
        ipAddress: meta.ipAddress,
        propertyScopeId: reservation.propertyId,
        after: toAuditJson({
          settlementId: settlement.id,
          reservationId: reservation.id,
          propertyId: reservation.propertyId,
          sourceReservationId: row.sourceReservationId,
          sourcePayoutId: row.sourcePayoutId,
          sourceTransactionId: row.sourceTransactionId,
          expectedPayout: amounts.expectedPayout.toJSON(),
          actualReceipt: amounts.actualReceipt.toJSON(),
          varianceAmount: amounts.varianceAmount.toJSON(),
          varianceId,
          expectedTransactionId: expectedTransaction.id,
          receiptTransactionId: receiptTransaction.id
        }),
        reason: "S7 Airbnb settlement CSV import",
        requestId: meta.requestId,
        occurredAt: new Date()
      });

      imported.push(result);
    }

    return { imported };
  });
}

export async function listAirbnbSettlementVariances(
  ctx: FinanceActorContext,
  deps: AirbnbSettlementServiceDeps = {}
): Promise<AirbnbSettlementVarianceSummary[]> {
  assertAllowed(ctx, "view", "financial_transaction");
  assertAllowed(ctx, "reconcile", "financial_transaction");

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const rows = await new FinanceRepository(tx, ctx.organizationId).listOpenAirbnbSettlementVariances();

    return rows.map((row) => ({
      id: row.id,
      settlementId: row.settlementId,
      reservationId: row.reservationId,
      reservationReference: row.reservationReference,
      propertyId: row.propertyId,
      propertyName: row.propertyName,
      sourceReservationId: row.sourceReservationId,
      sourcePayoutId: row.sourcePayoutId,
      sourceTransactionId: row.sourceTransactionId,
      expectedAmount: Money.of(row.expectedAmount, row.currency),
      actualAmount: Money.of(row.actualAmount, row.currency),
      varianceAmount: Money.of(row.varianceAmount, row.currency),
      reason: row.reason,
      action: row.action,
      status: row.status,
      createdAt: row.createdAt
    }));
  });
}

export async function reverseAirbnbSettlement(
  ctx: FinanceActorContext,
  input: ReverseAirbnbSettlementInput,
  deps: AirbnbSettlementServiceDeps = {}
): Promise<AirbnbSettlementReversalResult> {
  input = reverseAirbnbSettlementInputSchema.parse(input);
  if (!ctx.authContext.permissions.has("financial_transaction:void")) throw new AirbnbSettlementAuthorizationError();
  if (ctx.actorId !== ctx.authContext.userAccountId || ctx.organizationId !== ctx.authContext.organizationId) throw new AirbnbSettlementAuthorizationError();
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new FinanceRepository(tx, ctx.organizationId);
    const settlement = await repository.findAirbnbSettlement(input.settlementId);

    if (!settlement) {
      throw new AirbnbSettlementNotFoundError("Airbnb settlement does not exist in this tenant");
    }

    const now = await repository.lockReservationFinancialCorrection(settlement.reservationId);
    const current = { ...ctx, authContext: await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId) };
    const target = { organizationId: ctx.organizationId, propertyId: settlement.propertyId, reservationId: settlement.reservationId,
      type: "financial_transaction" as const, dataClass: "financial" as const };
    for (const authority of [ctx.authContext, current.authContext]) {
      if (!authorize(authority, "view", target, now) || !authorize(authority, "void", target, now) ||
        !authorize(authority, "reconcile", target, now)) throw new AirbnbSettlementAuthorizationError();
    }

    const originals = await repository.findPostingTransactionsForAirbnbSettlement(settlement.id);
    if (originals.length === 0) {
      throw new AirbnbSettlementNotFoundError("Airbnb settlement has no active postings");
    }

    const reversalKeys = originals.map((transaction) => `${input.idempotencyKey}:reverse:${transaction.id}`);
    const existingReversals = await repository.findTransactionsByIdempotencyKeys(reversalKeys);
    if (existingReversals.length === originals.length) {
      const audit = await repository.financialReversalAudit("airbnb.settlement.reversed", "airbnb_settlement", [settlement.id]);
      if (!matchesFinancialReversalAttempt({ actorId: ctx.actorId, reason: input.reason, originalIds: originals.map(row => row.id), reversals: existingReversals, audit })) throw new AirbnbSettlementConflictError();
      return {
        settlementId: settlement.id,
        reversalTransactionIds: existingReversals.map((transaction) => transaction.id),
        idempotent: true
      };
    }

    if (originals.some((transaction) => transaction.reversedByTransactions.length > 0)) {
      throw new AirbnbSettlementConflictError("Airbnb settlement has already been reversed");
    }

    const reversalTransactions: PostingTransaction[] = [];
    for (const original of originals) {
      const postings = mirrorPostings(original, settlement.id);
      assertFinancePostingsBalanced(postings);
      const reversal = await repository.createFinancialTransaction({
        reference: `${original.reference}:REV:${input.idempotencyKey.slice(0, 8)}`,
        occurredAt: now,
        description: `Reversal of ${original.reference}`,
        reversesTransactionId: original.id,
        idempotencyKey: `${input.idempotencyKey}:reverse:${original.id}`,
        createdBy: ctx.actorId,
        postings
      });
      reversalTransactions.push(reversal);
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "airbnb.settlement.reversed",
      resourceType: "airbnb_settlement",
      resourceId: settlement.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: settlement.propertyId,
      after: toAuditJson({
        settlementId: settlement.id,
        originalTransactionIds: originals.map((transaction) => transaction.id),
        reversalTransactionIds: reversalTransactions.map((transaction) => transaction.id)
      }),
      reason: input.reason,
      requestId: meta.requestId,
      occurredAt: now
    });

    return {
      settlementId: settlement.id,
      reversalTransactionIds: reversalTransactions.map((transaction) => transaction.id),
      idempotent: false
    };
  });
}
