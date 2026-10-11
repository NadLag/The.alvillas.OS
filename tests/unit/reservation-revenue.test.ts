import { describe, expect, it } from "vitest";
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
});
