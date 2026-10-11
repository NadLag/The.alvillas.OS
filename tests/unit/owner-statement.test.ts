import { describe, expect, it } from "vitest";
import {
  buildOwnerStatement,
  dateOnlyToUtc,
  statementPeriodDates,
  type RawOwnerLedgerPosting
} from "@/modules/owner-portal/domain/owner-statement";

type PostingOverrides = Omit<Partial<RawOwnerLedgerPosting>, "occurredAt"> & {
    id: string;
    occurredAt: string;
    side: "DEBIT" | "CREDIT";
    amount: string;
    bucket: string;
  };

function posting(overrides: PostingOverrides): RawOwnerLedgerPosting {
  return {
    transactionId: `tx-${overrides.id}`,
    reference: `TX-${overrides.id}`,
    description: null,
    currency: "MAD",
    dimensions: {
      reservation_reference: `RES-${overrides.id}`,
      source: "DIRECT"
    },
    locationName: "Operating bank",
    locationCode: "BANK_A_INTERNAL",
    ...overrides,
    occurredAt: new Date(`${overrides.occurredAt}T12:00:00.000Z`)
  };
}

describe("owner statement generation", () => {
  it("derives opening, period totals, bucket totals, and closing from postings", () => {
    const { periodStart, periodEnd } = statementPeriodDates({
      from: "2027-04-01",
      to: "2027-04-30"
    });
    const statement = buildOwnerStatement({
      organizationId: "org-1",
      ownerId: "owner-1",
      ownerName: "Owner One",
      propertyId: "property-1",
      propertyName: "Villa One",
      periodStart,
      periodEnd,
      currency: "MAD",
      postings: [
        posting({
          id: "opening",
          occurredAt: "2027-03-25",
          side: "CREDIT",
          amount: "1000.00",
          bucket: "OWNER_REVENUE"
        }),
        posting({
          id: "revenue",
          occurredAt: "2027-04-05",
          side: "CREDIT",
          amount: "8000.00",
          bucket: "OWNER_REVENUE"
        }),
        posting({
          id: "services",
          occurredAt: "2027-04-07",
          side: "CREDIT",
          amount: "500.00",
          bucket: "OWNER_SERVICES"
        }),
        posting({
          id: "commission",
          occurredAt: "2027-04-08",
          side: "DEBIT",
          amount: "1600.00",
          bucket: "COMMISSION"
        }),
        posting({
          id: "expense",
          occurredAt: "2027-04-10",
          side: "DEBIT",
          amount: "600.00",
          bucket: "OWNER_EXPENSE"
        }),
        posting({
          id: "payout",
          occurredAt: "2027-04-20",
          side: "DEBIT",
          amount: "2000.00",
          bucket: "PAYOUT"
        })
      ]
    });

    expect(statement.openingBalance.toJSON()).toEqual({ amount: "1000.00", currency: "MAD" });
    expect(statement.periodCreditTotal.toJSON()).toEqual({ amount: "8500.00", currency: "MAD" });
    expect(statement.periodDebitTotal.toJSON()).toEqual({ amount: "4200.00", currency: "MAD" });
    expect(statement.closingBalance.toJSON()).toEqual({ amount: "5300.00", currency: "MAD" });
    expect(statement.bucketTotals.OWNER_REVENUE.toJSON().amount).toBe("8000.00");
    expect(statement.bucketTotals.OWNER_SERVICES.toJSON().amount).toBe("500.00");
    expect(statement.bucketTotals.COMMISSION.toJSON().amount).toBe("-1600.00");
    expect(statement.lines).toHaveLength(5);
  });

  it("treats reversal postings as ordinary append-only movements", () => {
    const periodStart = dateOnlyToUtc("2027-04-01");
    const periodEnd = dateOnlyToUtc("2027-05-01");
    const statement = buildOwnerStatement({
      organizationId: "org-1",
      ownerId: "owner-1",
      ownerName: "Owner One",
      propertyId: "property-1",
      propertyName: "Villa One",
      periodStart,
      periodEnd,
      currency: "MAD",
      postings: [
        posting({
          id: "expense",
          occurredAt: "2027-04-10",
          side: "DEBIT",
          amount: "600.00",
          bucket: "OWNER_EXPENSE"
        }),
        posting({
          id: "expense-reversal",
          occurredAt: "2027-04-11",
          side: "CREDIT",
          amount: "600.00",
          bucket: "OWNER_EXPENSE"
        })
      ]
    });

    expect(statement.bucketTotals.OWNER_EXPENSE.toJSON().amount).toBe("0.00");
    expect(statement.closingBalance.toJSON().amount).toBe("0.00");
    expect(statement.lines).toHaveLength(2);
  });

  it("rejects mixed currencies instead of adding them", () => {
    expect(() =>
      buildOwnerStatement({
        organizationId: "org-1",
        ownerId: "owner-1",
        ownerName: "Owner One",
        propertyId: "property-1",
        propertyName: "Villa One",
        periodStart: dateOnlyToUtc("2027-04-01"),
        periodEnd: dateOnlyToUtc("2027-05-01"),
        currency: "MAD",
        postings: [
          posting({
            id: "mad",
            occurredAt: "2027-04-10",
            side: "CREDIT",
            amount: "600.00",
            bucket: "OWNER_REVENUE"
          }),
          posting({
            id: "eur",
            occurredAt: "2027-04-11",
            side: "CREDIT",
            amount: "60.00",
            bucket: "OWNER_REVENUE",
            currency: "EUR"
          })
        ]
      })
    ).toThrow("cannot mix currencies");
  });
});
