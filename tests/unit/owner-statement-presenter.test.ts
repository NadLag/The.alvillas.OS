import { describe, expect, it } from "vitest";
import { buildOwnerStatement, dateOnlyToUtc } from "@/modules/owner-portal/domain/owner-statement";
import { presentOwnerStatement } from "@/modules/owner-portal/application/owner-statement-presenter";
import { maskedValue } from "@/platform/authz/present";
import { permissionKey, type DataClass } from "@/platform/authz/authorize";

const statement = buildOwnerStatement({
  organizationId: "org-a",
  ownerId: "owner-a",
  ownerName: "Owner A",
  propertyId: "property-a",
  propertyName: "Villa A",
  periodStart: dateOnlyToUtc("2027-04-01"),
  periodEnd: dateOnlyToUtc("2027-05-01"),
  currency: "MAD",
  postings: [
    {
      id: "posting-a",
      transactionId: "tx-a",
      reference: "TX-A",
      occurredAt: new Date("2027-04-02T12:00:00.000Z"),
      description: null,
      side: "CREDIT",
      amount: "8000.00",
      currency: "MAD",
      bucket: "OWNER_REVENUE",
      dimensions: null,
      locationName: "Operating bank",
      locationCode: "BANK_A_INTERNAL"
    }
  ]
});

function context(visibleDataClasses: DataClass[]) {
  return {
    organizationId: "org-a",
    permissions: new Set([permissionKey("owner_statement", "view")]),
    scopes: [{ organizationId: "org-a", resourceType: "owner_statement", resourceId: "property-a" }],
    visibleDataClasses: new Set<DataClass>(visibleDataClasses)
  };
}

describe("owner statement presenter", () => {
  it("shows own financial fields through the central serializer", () => {
    const presented = presentOwnerStatement(context(["financial"]), statement);

    expect(presented.closingBalance.toJSON()).toEqual({ amount: "8000.00", currency: "MAD" });
    expect(presented.lines).toHaveLength(1);
    expect(presented).not.toHaveProperty("internalLocationCode");
  });

  it("masks financial fields when the viewer lacks financial visibility", () => {
    const presented = presentOwnerStatement(context([]), statement);

    expect(presented.closingBalance).toBe(maskedValue);
    expect(presented.lines).toBe(maskedValue);
  });

  it("denies wrong-scope statement presentation", () => {
    expect(() =>
      presentOwnerStatement(
        {
          ...context(["financial"]),
          scopes: [
            {
              organizationId: "org-a",
              resourceType: "owner_statement",
              resourceId: "property-b"
            }
          ]
        },
        statement
      )
    ).toThrow("Not authorized to present resource");
  });
});
