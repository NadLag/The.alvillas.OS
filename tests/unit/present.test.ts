import { describe, expect, it } from "vitest";
import { permissionKey, type AuthContext, type DataClass } from "@/platform/authz/authorize";
import {
  catalogFieldPolicy,
  maskedValue,
  present,
  type FieldPolicy,
  type PresentationContext
} from "@/platform/authz/present";

type ReservationView = {
  id: string;
  guestFirstName: string;
  payoutAmount: string;
  passportUrl: string;
  assignedPersonId: string;
  staffCompensation: string;
};

const policy: FieldPolicy<ReservationView> = {
  payoutAmount: { dataClass: "financial" },
  passportUrl: { dataClass: "sensitive", mask: "omit" },
  staffCompensation: { dataClass: "personal", selfField: "assignedPersonId" }
};

const resource = {
  type: "reservation",
  organizationId: "org-a",
  id: "res-1",
  data: {
    id: "res-1",
    guestFirstName: "Nadia",
    payoutAmount: "8000.00 MAD",
    passportUrl: "https://signed.example/passport",
    assignedPersonId: "person-1",
    staffCompensation: "500.00 MAD"
  }
};

function context(overrides: Partial<AuthContext> = {}): PresentationContext {
  return {
    organizationId: "org-a",
    permissions: new Set([permissionKey("reservation", "view")]),
    scopes: [{ organizationId: "org-a", resourceType: "reservation", resourceId: "res-1" }],
    visibleDataClasses: new Set<DataClass>(["operational", "guest"]),
    ...overrides
  };
}

describe("present", () => {
  it("masks protected fields centrally", () => {
    expect(present(context(), "view", resource, policy)).toEqual({
      id: "res-1",
      guestFirstName: "Nadia",
      payoutAmount: maskedValue,
      assignedPersonId: "person-1",
      staffCompensation: maskedValue
    });
  });

  it("allows fields when the data class is visible", () => {
    expect(
      present(
        {
          ...context(),
          visibleDataClasses: new Set<DataClass>(["operational", "guest", "financial"])
        },
        "view",
        resource,
        policy
      )
    ).toMatchObject({ payoutAmount: "8000.00 MAD" });
  });

  it("allows self-owned personal fields", () => {
    expect(
      present(
        {
          ...context(),
          subjectPersonId: "person-1"
        },
        "view",
        resource,
        policy
      )
    ).toMatchObject({ staffCompensation: "500.00 MAD" });
  });

  it("fails closed when resource authorization fails", () => {
    expect(() =>
      present(
        context({ scopes: [{ organizationId: "org-a", resourceType: "reservation", resourceId: "res-2" }] }),
        "view",
        resource,
        policy
      )
    ).toThrow("Not authorized to present resource");
  });

  it("can derive financial masking from the central field policy catalog", () => {
    expect(
      present(
        context(),
        "view",
        {
          type: "reservation",
          organizationId: "org-a",
          id: "res-1",
          data: {
            id: "res-1",
            guestFirstName: "Nadia",
            revenue: "8000.00 MAD",
            guestEmail: "nadia@example.test"
          }
        },
        catalogFieldPolicy("reservation")
      )
    ).toMatchObject({
      id: "res-1",
      guestFirstName: "Nadia",
      revenue: maskedValue,
      guestEmail: "nadia@example.test"
    });
  });
});
