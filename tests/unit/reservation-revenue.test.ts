import { describe, expect, it } from "vitest";
import {
  AirbnbSettlementAuthorizationError,
  importAirbnbSettlementCsv,
  reverseAirbnbSettlement
} from "@/modules/finance/application/airbnb-settlement-service";
import {
  buildActualAirbnbReceiptPostings,
  buildExpectedAirbnbSettlementPostings,
  parseAirbnbSettlementCsv,
  settlementVariance
} from "@/modules/finance/domain/airbnb-settlement";
import {
  ReservationRevenueAuthorizationError,
  recordReservationAccommodationRevenue,
  reverseReservationAccommodationRevenue
} from "@/modules/finance/application/reservation-revenue-service";
import {
  allocateGrossRevenueByOwnerShare,
  assertFinancePostingsBalanced,
  calculateOwnerCommission,
  withCommissionAllocations,
  type FinancePostingDraft
} from "@/modules/finance/domain/reservation-revenue";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";
import type { TenantTransactionRunner } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";

const deniedDb: TenantTransactionRunner = {
  $transaction() {
    return Promise.reject(new Error("database should not be reached for denied finance access"));
  }
};

function actor(authContext: AuthContext): ReservationActorContext {
  return {
    organizationId: authContext.organizationId,
    actorId: "018f0a0b-0000-7000-9000-000000000811",
    personId: "018f0a0b-0000-7000-9000-000000000812",
    authContext
  };
}

describe("reservation revenue posting domain", () => {
  it("allocates owner revenue with the rounded remainder on the final owner", () => {
    const allocations = allocateGrossRevenueByOwnerShare(Money.of("100.00", "MAD"), [
      { ownerId: "owner-a", ownerName: "Owner A", shareBps: 3333 },
      { ownerId: "owner-b", ownerName: "Owner B", shareBps: 3333 },
      { ownerId: "owner-c", ownerName: "Owner C", shareBps: 3334 }
    ]);

    expect(allocations.map((allocation) => allocation.grossAmount.toJSON().amount)).toEqual([
      "33.33",
      "33.33",
      "33.34"
    ]);
  });

  it("calculates commission from owner gross revenue without JavaScript floats", () => {
    const commission = calculateOwnerCommission({
      ownerGrossAmount: Money.of("8000.00", "MAD"),
      commissionRateBps: 2000
    });

    expect(commission.toJSON()).toEqual({ amount: "1600.00", currency: "MAD" });
  });

  it("builds balanced owner revenue and commission posting drafts", () => {
    const gross = Money.of("8000.00", "MAD");
    const allocations = withCommissionAllocations(
      allocateGrossRevenueByOwnerShare(gross, [
        { ownerId: "owner-a", ownerName: "Owner A", shareBps: 10000 }
      ]),
      () => 2000
    );
    const allocation = allocations[0];
    const revenuePostings: FinancePostingDraft[] = [
      {
        ledgerAccountId: "bank",
        side: "DEBIT",
        amount: gross,
        bucket: "OWNER_REVENUE",
        dimensions: {}
      },
      {
        ledgerAccountId: "owner-payable",
        side: "CREDIT",
        amount: allocation.grossAmount,
        bucket: "OWNER_REVENUE",
        dimensions: {}
      }
    ];
    const commissionPostings: FinancePostingDraft[] = [
      {
        ledgerAccountId: "owner-payable",
        side: "DEBIT",
        amount: allocation.commissionAmount,
        bucket: "COMMISSION",
        dimensions: {}
      },
      {
        ledgerAccountId: "commission-revenue",
        side: "CREDIT",
        amount: allocation.commissionAmount,
        bucket: "COMMISSION",
        dimensions: {}
      }
    ];

    expect(() => assertFinancePostingsBalanced(revenuePostings)).not.toThrow();
    expect(() => assertFinancePostingsBalanced(commissionPostings)).not.toThrow();
    expect(allocation.netAmount.toJSON().amount).toBe("6400.00");
  });
});

describe("Airbnb settlement reconciliation domain", () => {
  it("parses Airbnb payout CSV rows with source identifiers and amounts", () => {
    const rows = parseAirbnbSettlementCsv(`source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action
HMABC123,PO-100,TX-100,MAD,5500.00,300.00,5200.00,5150.00,Bank fee,Review payout`);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceReservationId: "HMABC123",
      sourcePayoutId: "PO-100",
      sourceTransactionId: "TX-100",
      currency: "MAD",
      grossAmount: "5500.00",
      platformFee: "300.00",
      expectedPayout: "5200.00",
      actualReceipt: "5150.00",
      reason: "Bank fee",
      action: "Review payout"
    });
  });

  it("builds balanced Airbnb expected and actual receipt postings with a 50 MAD variance", () => {
    const expectedPayout = Money.of("5200.00", "MAD");
    const actualReceipt = Money.of("5150.00", "MAD");
    const variance = settlementVariance(expectedPayout, actualReceipt);
    const expectedPostings = buildExpectedAirbnbSettlementPostings({
      otaClearingAccountId: "ota-clearing",
      ownerPayableAccountId: "owner-payable",
      grossAmount: Money.of("5500.00", "MAD"),
      platformFee: Money.of("300.00", "MAD"),
      expectedPayout,
      dimensions: {}
    });
    const actualPostings = buildActualAirbnbReceiptPostings({
      receivedAccountId: "bank",
      otaClearingAccountId: "ota-clearing",
      varianceSuspenseAccountId: "variance-suspense",
      expectedPayout,
      actualReceipt,
      dimensions: {}
    });

    expect(variance.toJSON()).toEqual({ amount: "50.00", currency: "MAD" });
    expect(() => assertFinancePostingsBalanced(expectedPostings)).not.toThrow();
    expect(() => assertFinancePostingsBalanced(actualPostings)).not.toThrow();
    expect(expectedPostings.map((posting) => [posting.side, posting.bucket, posting.amount.toJSON().amount])).toEqual([
      ["DEBIT", "OTA_SETTLEMENT", "5200.00"],
      ["DEBIT", "OTA_FEE", "300.00"],
      ["CREDIT", "OWNER_REVENUE", "5500.00"]
    ]);
    expect(actualPostings.map((posting) => [posting.side, posting.bucket, posting.amount.toJSON().amount])).toEqual([
      ["DEBIT", "OTA_RECEIPT", "5150.00"],
      ["DEBIT", "VARIANCE", "50.00"],
      ["CREDIT", "OTA_SETTLEMENT", "5200.00"]
    ]);
  });
});

describe("reservation revenue authorization", () => {
  it("denies revenue posting before reaching the database without financial create access", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([permissionKey("reservation", "view")]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(
      recordReservationAccommodationRevenue(
        ctx,
        {
          reservationId: "018f0a0b-0000-7000-9000-000000000901",
          amount: "8000.00",
          currency: "MAD",
          receivedAccountId: "018f0a0b-0000-7000-9000-000000000902",
          idempotencyKey: "018f0a0b-0000-7000-9000-000000000903"
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueAuthorizationError);
  });

  it("denies revenue reversal before reaching the database without financial void access", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([
        permissionKey("reservation", "view"),
        permissionKey("financial_transaction", "create")
      ]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(
      reverseReservationAccommodationRevenue(
        ctx,
        {
          reservationId: "018f0a0b-0000-7000-9000-000000000901",
          reason: "Test reversal",
          idempotencyKey: "018f0a0b-0000-7000-9000-000000000904"
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(ReservationRevenueAuthorizationError);
  });

  it("denies Airbnb settlement import before reaching the database without reconcile access", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([
        permissionKey("reservation", "view"),
        permissionKey("financial_transaction", "view"),
        permissionKey("financial_transaction", "create")
      ]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(
      importAirbnbSettlementCsv(
        ctx,
        {
          csv: "source_reservation_id,source_payout_id,source_transaction_id,currency,gross_amount,platform_fee,expected_payout,actual_receipt,reason,action\nHMABC123,PO-100,TX-100,MAD,5500.00,300.00,5200.00,5150.00,Bank fee,Review payout",
          receivedAccountId: "018f0a0b-0000-7000-9000-000000000902",
          idempotencyKey: "018f0a0b-0000-7000-9000-000000000905"
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError);
  });

  it("denies Airbnb settlement reversal before reaching the database without void access", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([
        permissionKey("reservation", "view"),
        permissionKey("financial_transaction", "view"),
        permissionKey("financial_transaction", "reconcile")
      ]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(
      reverseAirbnbSettlement(
        ctx,
        {
          settlementId: "018f0a0b-0000-7000-9000-000000000906",
          reason: "Test reversal",
          idempotencyKey: "018f0a0b-0000-7000-9000-000000000907"
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(AirbnbSettlementAuthorizationError);
  });
});
