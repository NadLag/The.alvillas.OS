import { headers } from "next/headers";
import type { Prisma } from "@prisma/client";
import {
  allocateGrossRevenueByOwnerShare,
  assertFinancePostingsBalanced,
  parseCommissionRuleValue,
  parseRecordReservationRevenueInput,
  parseReverseReservationRevenueInput,
  reverseReservationRevenueInputSchema,
  withCommissionAllocations,
  type FinancePostingDraft,
  type RecordReservationRevenueInput,
  type ReverseReservationRevenueInput
} from "@/modules/finance/domain/reservation-revenue";
import {
  FinanceRepository,
  type CommissionRuleRow,
  type FinanceLedgerAccount,
  type PostingTransaction
} from "@/modules/finance/infrastructure/finance-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { authorize, type Action, type AuthContext } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { matchesFinancialReversalAttempt } from "../domain/financial-reversal";
import { recheckFinanceAuthorization } from "./finance-access";
import { configRuleSnapshotMetadata } from "@/platform/config/config-rule-repository";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";

export class ReservationRevenueAuthorizationError extends Error {
  constructor(message = "Reservation revenue action is not authorized") {
    super(message);
    this.name = "ReservationRevenueAuthorizationError";
  }
}

export class ReservationRevenueNotFoundError extends Error {
  constructor(message = "Reservation revenue resource was not found") {
    super(message);
    this.name = "ReservationRevenueNotFoundError";
  }
}

export class ReservationRevenueConfigError extends Error {
  constructor(message = "Reservation revenue configuration is missing or invalid") {
    super(message);
    this.name = "ReservationRevenueConfigError";
  }
}

export class ReservationRevenueConflictError extends Error {
  constructor(message = "Reservation revenue has already been posted") {
    super(message);
    this.name = "ReservationRevenueConflictError";
  }
}

type ReservationRevenueServiceDeps = {
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

type SnapshotAllocation = {
  ownerId: string;
  ownerName: string;
  shareBps: number;
  grossAmount: Money;
  commissionRateBps: number;
  commissionAmount: Money;
  netAmount: Money;
  commissionSnapshotId: string;
  commissionBasis: string;
  accrualEvent: string;
};

export type RevenuePostingAccountOption = {
  id: string;
  name: string;
  code: string;
};

export type ReservationRevenuePostingResult = {
  reservationId: string;
  propertyId: string;
  revenueTransactionId: string;
  commissionTransactionId: string | null;
  grossAmount: Money;
  commissionTotal: Money;
  ownerNetTotal: Money;
  idempotent: boolean;
};

export type ReservationRevenueReversalResult = {
  reservationId: string;
  propertyId: string;
  reversalTransactionIds: string[];
  idempotent: boolean;
};

function db(deps: ReservationRevenueServiceDeps): TenantTransactionRunner {
  return deps.db ?? prisma;
}

async function auditMeta(deps: ReservationRevenueServiceDeps): Promise<AuditMeta> {
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
    throw new ReservationRevenueAuthorizationError();
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
    code?: string;
    accountType: string;
    normalSide: "DEBIT" | "CREDIT";
  }
): void {
  if (account.archivedAt) {
    throw new ReservationRevenueConfigError("Ledger account is archived");
  }

  if (expected.code && account.code !== expected.code) {
    throw new ReservationRevenueConfigError("Ledger account code is invalid");
  }

  if (account.accountType !== expected.accountType || account.normalSide !== expected.normalSide) {
    throw new ReservationRevenueConfigError("Ledger account type is invalid");
  }
}

function transactionKeys(idempotencyKey: string): {
  revenueKey: string;
  commissionKey: string;
} {
  return {
    revenueKey: `${idempotencyKey}:revenue`,
    commissionKey: `${idempotencyKey}:commission`
  };
}

function sumMoney(currency: string, values: readonly Money[]): Money {
  return values.reduce((sum, value) => sum.add(value), Money.zero(currency));
}

function isSamePostingAttempt(
  transactions: readonly PostingTransaction[],
  keys: { revenueKey: string; commissionKey: string }
): boolean {
  const allowedKeys = new Set([keys.revenueKey, keys.commissionKey]);
  return transactions.length > 0 && transactions.every((transaction) => {
    const key = transaction.idempotencyKey;
    return typeof key === "string" && allowedKeys.has(key);
  });
}

function dimensions(input: {
  reservationId: string;
  reservationReference: string;
  propertyId: string;
  source: string;
  postingKind: string;
  ownerId?: string;
  commissionSnapshotId?: string;
  commissionRateBps?: number;
  commissionBasis?: string;
  reversalOfTransactionId?: string;
}): Record<string, unknown> {
  const values = {
    reservation_id: input.reservationId,
    reservation_reference: input.reservationReference,
    property_id: input.propertyId,
    source: input.source,
    posting_kind: input.postingKind,
    owner_id: input.ownerId,
    commission_snapshot_id: input.commissionSnapshotId,
    commission_rate_bps: input.commissionRateBps,
    commission_basis: input.commissionBasis,
    reversal_of_transaction_id: input.reversalOfTransactionId
  };

  return Object.fromEntries(Object.entries(values).filter((entry) => entry[1] !== undefined));
}

async function snapshotForOwner(input: {
  repository: FinanceRepository;
  reservation: {
    id: string;
    propertyId: string;
    createdAt: Date;
    source?: string;
  };
  ownerId: string;
  ownerName: string;
  shareBps: number;
  actorId: string;
}): Promise<{
  id: string;
  commissionRateBps: number;
  commissionBasis: string;
  accrualEvent: string;
}> {
  const existing = await input.repository.findCommissionSnapshot({
    reservationId: input.reservation.id,
    ownerId: input.ownerId
  });

  if (existing) {
    return {
      id: existing.id,
      commissionRateBps: existing.commissionRateBps,
      commissionBasis: existing.commissionBasis,
      accrualEvent: existing.accrualEvent
    };
  }

  const rule = await input.repository.resolveCommissionRule({
    propertyId: input.reservation.propertyId,
    ownerId: input.ownerId,
    source: input.reservation.source, asOf: input.reservation.createdAt
  });

  if (!rule) {
    throw new ReservationRevenueConfigError("Commission rule is not configured");
  }

  const parsed = parseCommissionRuleValue(rule.value);
  const expensePolicy = await input.repository.captureExpensePolicy({ propertyId: input.reservation.propertyId, ownerId: input.ownerId,
    source: input.reservation.source, asOf: input.reservation.createdAt, inlineApproval: parsed.approval_thresholds });

  const snapshot = await input.repository.createCommissionSnapshot({
    reservationId: input.reservation.id,
    propertyId: input.reservation.propertyId,
    ownerId: input.ownerId,
    configRuleId: rule.id,
    shareBps: input.shareBps,
    commissionRateBps: parsed.rate_bps,
    commissionBasis: parsed.basis,
    accrualEvent: parsed.accrual_event,
    snapshotValue: { ...snapshotValue(rule, parsed, input), expense_policy_rules: expensePolicy },
    createdBy: input.actorId
  });

  return {
    id: snapshot.id,
    commissionRateBps: snapshot.commissionRateBps,
    commissionBasis: snapshot.commissionBasis,
    accrualEvent: snapshot.accrualEvent
  };
}

/** Confirmation and posting share the same immutable owner/rule snapshot writer. */
export async function captureReservationCommissionSnapshots(tx: TenantTransaction, organizationId: string, reservationId: string, actorId: string) {
  const repository = new FinanceRepository(tx, organizationId);
  const reservation = await repository.findReservation(reservationId);
  if (!reservation) throw new ReservationRevenueNotFoundError();
  const snapshots = [];
  for (const owner of reservation.owners) {
    const rule = await repository.resolveCommissionRule({ propertyId: reservation.propertyId, ownerId: owner.ownerId, source: reservation.source, asOf: reservation.createdAt });
    if (!rule) { snapshots.push({ ...owner, configurationMissing: true }); continue; }
    const snapshot = await snapshotForOwner({ repository, reservation, ...owner, actorId });
    snapshots.push({ ...owner, ...snapshot, configurationMissing: false });
  }
  return snapshots;
}

function snapshotValue(
  rule: CommissionRuleRow,
  parsed: ReturnType<typeof parseCommissionRuleValue>,
  input: {
    ownerId: string;
    ownerName: string;
    shareBps: number;
  }
): Prisma.InputJsonObject {
  return {
    ...configRuleSnapshotMetadata(rule),
    owner_id: input.ownerId,
    owner_name: input.ownerName,
    owner_share_bps: input.shareBps,
    rate_bps: parsed.rate_bps,
    basis: parsed.basis,
    accrual_event: parsed.accrual_event,
    ...(parsed.expense_treatments === undefined
      ? {}
      : { expense_treatments: parsed.expense_treatments }),
    ...(parsed.approval_thresholds === undefined
      ? {}
      : { approval_thresholds: parsed.approval_thresholds }),
    ...(parsed.payout_rule === undefined ? {} : { payout_rule: parsed.payout_rule })
  };
}

async function buildSnapshotAllocations(input: {
  repository: FinanceRepository;
  reservation: {
    id: string;
    propertyId: string;
    createdAt: Date;
    owners: Array<{ ownerId: string; ownerName: string; shareBps: number }>;
  };
  grossAmount: Money;
  actorId: string;
}): Promise<SnapshotAllocation[]> {
  const grossAllocations = allocateGrossRevenueByOwnerShare(
    input.grossAmount,
    input.reservation.owners
  );
  const snapshots = await Promise.all(
    grossAllocations.map((allocation) =>
      snapshotForOwner({
        repository: input.repository,
        reservation: input.reservation,
        ownerId: allocation.ownerId,
        ownerName: allocation.ownerName,
        shareBps: allocation.shareBps,
        actorId: input.actorId
      })
    )
  );
  const snapshotByOwner = new Map(
    snapshots.map((snapshot, index) => {
      const allocation = grossAllocations[index];
      if (!allocation) {
        throw new ReservationRevenueConfigError("Commission snapshot was not created");
      }

      return [allocation.ownerId, snapshot];
    })
  );

  if (snapshots.some(snapshot => snapshot.commissionBasis !== "GROSS_ACCOMMODATION")) throw new ReservationRevenueConfigError("Commission basis requires a dedicated posting workflow");
  return withCommissionAllocations(grossAllocations, (ownerId) => {
    const snapshot = snapshotByOwner.get(ownerId);
    if (!snapshot) {
      throw new ReservationRevenueConfigError("Commission snapshot was not created");
    }

    return snapshot.commissionRateBps;
  }).map((allocation) => {
    const snapshot = snapshotByOwner.get(allocation.ownerId);
    if (!snapshot) {
      throw new ReservationRevenueConfigError("Commission snapshot was not created");
    }

    return {
      ...allocation,
      commissionSnapshotId: snapshot.id,
      commissionBasis: snapshot.commissionBasis,
      accrualEvent: snapshot.accrualEvent
    };
  });
}

function buildRevenuePostings(input: {
  receivedAccountId: string;
  ownerPayableAccountId: string;
  grossAmount: Money;
  reservation: {
    id: string;
    reference: string;
    propertyId: string;
    source: string;
  };
  allocations: readonly SnapshotAllocation[];
}): FinancePostingDraft[] {
  return [
    {
      ledgerAccountId: input.receivedAccountId,
      side: "DEBIT",
      amount: input.grossAmount,
      bucket: "OWNER_REVENUE",
      dimensions: dimensions({
        reservationId: input.reservation.id,
        reservationReference: input.reservation.reference,
        propertyId: input.reservation.propertyId,
        source: input.reservation.source,
        postingKind: "accommodation_revenue_received"
      })
    },
    ...input.allocations.map((allocation) => ({
      ledgerAccountId: input.ownerPayableAccountId,
      side: "CREDIT" as const,
      amount: allocation.grossAmount,
      bucket: "OWNER_REVENUE",
      dimensions: dimensions({
        reservationId: input.reservation.id,
        reservationReference: input.reservation.reference,
        propertyId: input.reservation.propertyId,
        source: input.reservation.source,
        postingKind: "owner_accommodation_revenue",
        ownerId: allocation.ownerId,
        commissionSnapshotId: allocation.commissionSnapshotId,
        commissionRateBps: allocation.commissionRateBps,
        commissionBasis: allocation.commissionBasis
      })
    }))
  ];
}

function buildCommissionPostings(input: {
  ownerPayableAccountId: string;
  commissionRevenueAccountId: string;
  commissionTotal: Money;
  reservation: {
    id: string;
    reference: string;
    propertyId: string;
    source: string;
  };
  allocations: readonly SnapshotAllocation[];
}): FinancePostingDraft[] {
  return [
    ...input.allocations
      .filter((allocation) => allocation.commissionAmount.amount.gt(0))
      .map((allocation) => ({
        ledgerAccountId: input.ownerPayableAccountId,
        side: "DEBIT" as const,
        amount: allocation.commissionAmount,
        bucket: "COMMISSION",
        dimensions: dimensions({
          reservationId: input.reservation.id,
          reservationReference: input.reservation.reference,
          propertyId: input.reservation.propertyId,
          source: input.reservation.source,
          postingKind: "owner_commission",
          ownerId: allocation.ownerId,
          commissionSnapshotId: allocation.commissionSnapshotId,
          commissionRateBps: allocation.commissionRateBps,
          commissionBasis: allocation.commissionBasis
        })
      })),
    {
      ledgerAccountId: input.commissionRevenueAccountId,
      side: "CREDIT",
      amount: input.commissionTotal,
      bucket: "COMMISSION",
      dimensions: dimensions({
        reservationId: input.reservation.id,
        reservationReference: input.reservation.reference,
        propertyId: input.reservation.propertyId,
        source: input.reservation.source,
        postingKind: "alvillas_commission_revenue"
      })
    }
  ];
}

function mirrorPostings(original: PostingTransaction): FinancePostingDraft[] {
  return original.postings.map((posting) => ({
    ledgerAccountId: posting.ledgerAccountId,
    side: posting.side === "DEBIT" ? "CREDIT" : "DEBIT",
    amount: Money.of(posting.amount.toString(), posting.currency),
    bucket: posting.bucket,
    dimensions: {
      ...jsonObject(posting.dimensions),
      posting_kind: "reservation_revenue_reversal",
      reversal_of_transaction_id: original.id
    }
  }));
}

function idempotentRecordResult(input: {
  reservationId: string;
  propertyId: string;
  grossAmount: Money;
  transactions: readonly PostingTransaction[];
}): ReservationRevenuePostingResult {
  const revenue = input.transactions.find((transaction) =>
    transaction.postings.some((posting) => posting.bucket === "OWNER_REVENUE")
  );
  const commission = input.transactions.find((transaction) =>
    transaction.postings.some((posting) => posting.bucket === "COMMISSION")
  );
  const commissionTotal = sumMoney(
    input.grossAmount.currency,
    commission?.postings
      .filter((posting) => posting.bucket === "COMMISSION" && posting.side === "DEBIT")
      .map((posting) => Money.of(posting.amount.toString(), posting.currency)) ?? []
  );

  return {
    reservationId: input.reservationId,
    propertyId: input.propertyId,
    revenueTransactionId: revenue?.id ?? "",
    commissionTransactionId: commission?.id ?? null,
    grossAmount: input.grossAmount,
    commissionTotal,
    ownerNetTotal: input.grossAmount.subtract(commissionTotal),
    idempotent: true
  };
}

export function parseReservationRevenueInput(input: unknown) {
  return parseRecordReservationRevenueInput(input);
}

export function parseReservationRevenueReversalInput(input: unknown) {
  return parseReverseReservationRevenueInput(input);
}

export async function listRevenuePostingAccounts(
  ctx: FinanceActorContext,
  deps: ReservationRevenueServiceDeps = {}
): Promise<RevenuePostingAccountOption[]> {
  assertAllowed(ctx, "create", "financial_transaction");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    new FinanceRepository(tx, ctx.organizationId).listRevenuePostingAccounts()
  );
}

export async function listReservationsWithActiveRevenue(
  ctx: FinanceActorContext,
  deps: ReservationRevenueServiceDeps = {}
): Promise<string[]> {
  assertAllowed(ctx, "view", "reservation");
  assertAllowed(ctx, "view", "financial_transaction");

  return withTenant(db(deps), ctx.organizationId, async (tx) =>
    new FinanceRepository(tx, ctx.organizationId).listActiveRevenueReservationIds()
  );
}

export async function recordReservationAccommodationRevenue(
  ctx: FinanceActorContext,
  input: RecordReservationRevenueInput,
  deps: ReservationRevenueServiceDeps = {}
): Promise<ReservationRevenuePostingResult> {
  assertAllowed(ctx, "view", "reservation", input.reservationId);
  assertAllowed(ctx, "create", "financial_transaction");
  const meta = await auditMeta(deps);
  const keys = transactionKeys(input.idempotencyKey);
  const grossAmount = Money.of(input.amount, input.currency);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new FinanceRepository(tx, ctx.organizationId);
    const [baseCurrency, reservation] = await Promise.all([
      repository.findOrganizationBaseCurrency(),
      repository.findReservation(input.reservationId)
    ]);

    if (!reservation) {
      throw new ReservationRevenueNotFoundError("Reservation does not exist in this tenant");
    }

    if (grossAmount.currency !== baseCurrency) {
      throw new ReservationRevenueConfigError("Revenue currency must match the organization base currency");
    }

    const existingForReservation = await repository.findPostingTransactionsForReservation(input.reservationId);
    if (existingForReservation.length > 0) {
      if (isSamePostingAttempt(existingForReservation, keys)) {
        return idempotentRecordResult({
          reservationId: reservation.id,
          propertyId: reservation.propertyId,
          grossAmount,
          transactions: existingForReservation
        });
      }

      throw new ReservationRevenueConflictError();
    }

    const [receivedAccount, ownerPayable, commissionRevenue] = await Promise.all([
      repository.findLedgerAccountById(input.receivedAccountId),
      repository.ensureLedgerAccount({
        code: "OWNER_PAYABLE",
        name: "Owner payable",
        accountType: "CLAIM_OWNERSHIP",
        normalSide: "CREDIT"
      }),
      repository.ensureLedgerAccount({
        code: "ALVILLAS_COMMISSION_REVENUE",
        name: "ALVILLAS commission revenue",
        accountType: "ALVILLAS_OWN",
        normalSide: "CREDIT"
      })
    ]);

    if (!receivedAccount) {
      throw new ReservationRevenueNotFoundError("Received account does not exist in this tenant");
    }

    assertLedgerAccount(receivedAccount, {
      accountType: "ASSET_LOCATION",
      normalSide: "DEBIT"
    });
    assertLedgerAccount(ownerPayable, {
      code: "OWNER_PAYABLE",
      accountType: "CLAIM_OWNERSHIP",
      normalSide: "CREDIT"
    });
    assertLedgerAccount(commissionRevenue, {
      code: "ALVILLAS_COMMISSION_REVENUE",
      accountType: "ALVILLAS_OWN",
      normalSide: "CREDIT"
    });

    const allocations = await buildSnapshotAllocations({
      repository,
      reservation,
      grossAmount,
      actorId: ctx.actorId
    });
    const commissionTotal = sumMoney(
      grossAmount.currency,
      allocations.map((allocation) => allocation.commissionAmount)
    );
    const ownerNetTotal = grossAmount.subtract(commissionTotal);
    const revenuePostings = buildRevenuePostings({
      receivedAccountId: receivedAccount.id,
      ownerPayableAccountId: ownerPayable.id,
      grossAmount,
      reservation,
      allocations
    });
    assertFinancePostingsBalanced(revenuePostings);
    const financeTarget = { type: "financial_transaction" as const, organizationId: ctx.organizationId,
      propertyId: reservation.propertyId, reservationId: reservation.id, dataClass: "financial" as const };
    const recheckPosting = (at: Date) => recheckFinanceAuthorization(ctx, tx, at, [
      { action: "view", resource: { ...financeTarget, type: "reservation", id: reservation.id, dataClass: "operational" } },
      { action: "create", resource: financeTarget }
    ], new ReservationRevenueAuthorizationError());
    const revenueTransaction = await repository.createFinancialTransaction({
      reference: `${reservation.reference}:ACCOMMODATION_REVENUE`,
      occurredAt: new Date(),
      description: `Accommodation revenue for ${reservation.reference}`,
      idempotencyKey: keys.revenueKey,
      createdBy: ctx.actorId,
      postings: revenuePostings,
      recheckAuthorization: recheckPosting
    });

    let commissionTransaction: PostingTransaction | null = null;
    if (commissionTotal.amount.gt(0)) {
      const commissionPostings = buildCommissionPostings({
        ownerPayableAccountId: ownerPayable.id,
        commissionRevenueAccountId: commissionRevenue.id,
        commissionTotal,
        reservation,
        allocations
      });
      assertFinancePostingsBalanced(commissionPostings);
      commissionTransaction = await repository.createFinancialTransaction({
        reference: `${reservation.reference}:COMMISSION`,
        occurredAt: new Date(),
        description: `ALVILLAS commission for ${reservation.reference}`,
        idempotencyKey: keys.commissionKey,
        createdBy: ctx.actorId,
        postings: commissionPostings,
        recheckAuthorization: recheckPosting
      });
    }

    const result: ReservationRevenuePostingResult = {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      revenueTransactionId: revenueTransaction.id,
      commissionTransactionId: commissionTransaction?.id ?? null,
      grossAmount,
      commissionTotal,
      ownerNetTotal,
      idempotent: false
    };

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "reservation.revenue.posted",
      resourceType: "financial_transaction",
      resourceId: revenueTransaction.id,
      ipAddress: meta.ipAddress,
      propertyScopeId: reservation.propertyId,
      after: toAuditJson({
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        revenueTransactionId: revenueTransaction.id,
        commissionTransactionId: commissionTransaction?.id ?? null,
        grossAmount: grossAmount.toJSON(),
        commissionTotal: commissionTotal.toJSON(),
        ownerNetTotal: ownerNetTotal.toJSON(),
        ownerAllocations: allocations.map((allocation) => ({
          ownerId: allocation.ownerId,
          shareBps: allocation.shareBps,
          grossAmount: allocation.grossAmount.toJSON(),
          commissionRateBps: allocation.commissionRateBps,
          commissionAmount: allocation.commissionAmount.toJSON(),
          commissionSnapshotId: allocation.commissionSnapshotId
        }))
      }),
      reason: "S6 reservation revenue posting",
      requestId: meta.requestId,
      occurredAt: new Date()
    });

    return result;
  });
}

export async function reverseReservationAccommodationRevenue(
  ctx: FinanceActorContext,
  input: ReverseReservationRevenueInput,
  deps: ReservationRevenueServiceDeps = {}
): Promise<ReservationRevenueReversalResult> {
  input = reverseReservationRevenueInputSchema.parse(input);
  // Fail fast for absent authority; stored grants, scope and time are checked
  // with authorize() after the source lock, before any financial read or write.
  if (!ctx.authContext.permissions.has("financial_transaction:void")) throw new ReservationRevenueAuthorizationError();
  if (ctx.actorId !== ctx.authContext.userAccountId || ctx.organizationId !== ctx.authContext.organizationId) throw new ReservationRevenueAuthorizationError();
  const meta = await auditMeta(deps);

  return withTenant(db(deps), ctx.organizationId, async (tx) => {
    const repository = new FinanceRepository(tx, ctx.organizationId);
    const now = await repository.lockReservationFinancialCorrection(input.reservationId);
    const current = { ...ctx, authContext: await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId) };
    const reservation = await repository.findReservation(input.reservationId);

    if (!reservation) {
      throw new ReservationRevenueNotFoundError("Reservation does not exist in this tenant");
    }

    const target = { organizationId: ctx.organizationId, propertyId: reservation.propertyId, reservationId: reservation.id };
    for (const authority of [ctx.authContext, current.authContext]) {
      if (!authorize(authority, "view", { ...target, type: "reservation", id: reservation.id }, now) ||
        !authorize(authority, "view", { ...target, type: "financial_transaction", dataClass: "financial" }, now) ||
        !authorize(authority, "void", { ...target, type: "financial_transaction", dataClass: "financial" }, now)) throw new ReservationRevenueAuthorizationError();
    }

    const originals = await repository.findPostingTransactionsForReservation(input.reservationId, true);
    if (originals.some(transaction => transaction.postings.some(posting => jsonObject(posting.dimensions).airbnb_settlement_id)) &&
      [ctx.authContext, current.authContext].some(authority => !authorize(authority, "reconcile", { type: "financial_transaction", ...target, dataClass: "financial" }, now))) throw new ReservationRevenueAuthorizationError();
    if (originals.length === 0) {
      throw new ReservationRevenueNotFoundError("Reservation revenue has not been posted");
    }

    const reversalKeys = originals.map((transaction) => `${input.idempotencyKey}:reverse:${transaction.id}`);
    const existingReversals = await repository.findTransactionsByIdempotencyKeys(reversalKeys);
    if (existingReversals.length === originals.length) {
      const audit = await repository.financialReversalAudit("reservation.revenue.reversed", "financial_transaction", existingReversals.map(row => row.id));
      if (!matchesFinancialReversalAttempt({ actorId: ctx.actorId, reason: input.reason, originalIds: originals.map(row => row.id), reversals: existingReversals, audit })) throw new ReservationRevenueConflictError();
      return {
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        reversalTransactionIds: existingReversals.map((transaction) => transaction.id),
        idempotent: true
      };
    }

    if (originals.some((transaction) => transaction.reversedByTransactions.length > 0)) {
      throw new ReservationRevenueConflictError("Reservation revenue has already been reversed");
    }

    const reversalTransactions: PostingTransaction[] = [];
    for (const original of originals) {
      const postings = mirrorPostings(original);
      assertFinancePostingsBalanced(postings);
      const reversal = await repository.createFinancialTransaction({
        reference: `${original.reference}:REV:${input.idempotencyKey.slice(0, 8)}`,
        occurredAt: now,
        description: `Reversal of ${original.reference}`,
        reversesTransactionId: original.id,
        idempotencyKey: `${input.idempotencyKey}:reverse:${original.id}`,
        createdBy: ctx.actorId,
        postings,
        recheckAuthorization: at => recheckFinanceAuthorization(ctx, tx, at, [
          { action: "view", resource: { ...target, type: "reservation", id: reservation.id } },
          { action: "view", resource: { ...target, type: "financial_transaction", dataClass: "financial" } },
          { action: "void", resource: { ...target, type: "financial_transaction", dataClass: "financial" } },
          ...(originals.some(row => row.postings.some(posting => jsonObject(posting.dimensions).airbnb_settlement_id)) ?
            [{ action: "reconcile" as const, resource: { ...target, type: "financial_transaction" as const, dataClass: "financial" as const } }] : [])
        ], new ReservationRevenueAuthorizationError())
      });
      reversalTransactions.push(reversal);
    }

    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "reservation.revenue.reversed",
      resourceType: "financial_transaction",
      resourceId: reversalTransactions[0]?.id ?? null,
      ipAddress: meta.ipAddress,
      propertyScopeId: reservation.propertyId,
      after: toAuditJson({
        reservationId: reservation.id,
        propertyId: reservation.propertyId,
        originalTransactionIds: originals.map((transaction) => transaction.id),
        reversalTransactionIds: reversalTransactions.map((transaction) => transaction.id)
      }),
      reason: input.reason,
      requestId: meta.requestId,
      occurredAt: now
    });

    return {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      reversalTransactionIds: reversalTransactions.map((transaction) => transaction.id),
      idempotent: false
    };
  });
}
