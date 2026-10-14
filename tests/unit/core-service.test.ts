import { describe, expect, it } from "vitest";
import type { CoreActorContext } from "@/modules/core/application/core-access";
import {
  amendManagementAgreement,
  CoreAuthorizationError,
  allowedPropertyLifecycleTransitions,
  createManagementAgreement,
  createOwner,
  getProperty,
  listOwners,
  parseBookingChannelInput,
  parseManagementAgreementAmendmentInput,
  parseManagementAgreementInput,
  parsePropertyLifecycleTransitionInput,
  parsePropertyOperatingProfileInput,
  parsePropertyOwnershipInput,
  transitionPropertyLifecycle,
  updatePropertyOperatingProfile,
  updatePropertyOwnership,
  upsertPropertyBookingChannel
} from "@/modules/core/application/core-service";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";
import type { TenantTransactionRunner } from "@/platform/db/tenant";

const deniedDb: TenantTransactionRunner = {
  $transaction() {
    return Promise.reject(new Error("database should not be reached for denied core access"));
  }
};

function actor(authContext: AuthContext): CoreActorContext {
  return {
    organizationId: authContext.organizationId,
    actorId: "00000000-0000-7000-8000-000000000001",
    authContext
  };
}

const validManagementAgreementInput = {
  propertyId: "00000000-0000-7000-8000-000000000100",
  reference: "MA-2026-001",
  status: "ACTIVE",
  effectiveFrom: "2026-02-01T00:00:00.000Z",
  effectiveTo: "2027-02-01T00:00:00.000Z",
  commissionRateBps: "1800",
  commissionBasis: "GROSS_ACCOMMODATION",
  commissionAccrualEvent: "ON_CHECKOUT",
  expenseDefaultTreatment: "DEDUCT_FROM_PAYOUT",
  approvalThresholdKey: "maintenance",
  approvalThresholdAmount: "2500.00",
  approvalThresholdCurrency: "mad",
  approvalRequires: ["manager", "owner"],
  payoutCadence: "MONTHLY",
  payoutHoldDays: "7",
  payoutHoldbackBps: "500",
  noticePeriodDays: "60",
  ownerResponsibilities: ["insurance", "major repairs"],
  alvillasResponsibilities: ["guest operations", "owner reporting"],
  specialConditions: ["ramadan staffing plan"],
  reason: "Signed owner management agreement"
};
const validManagementAgreementAmendmentInput = {
  propertyId: validManagementAgreementInput.propertyId,
  agreementId: "00000000-0000-7000-8000-000000000200",
  effectiveFrom: "2026-06-01T00:00:00.000Z",
  effectiveTo: "2027-06-01T00:00:00.000Z",
  commissionRateBps: "2000",
  commissionBasis: "NET_OF_OTA_FEES",
  commissionAccrualEvent: "ON_RECEIPT",
  expenseDefaultTreatment: "OWNER_PAID",
  approvalThresholdKey: "maintenance",
  approvalThresholdAmount: "3000.00",
  approvalThresholdCurrency: "mad",
  approvalRequires: ["owner"],
  payoutCadence: "MONTHLY",
  payoutHoldDays: "10",
  payoutHoldbackBps: "250",
  noticePeriodDays: "75",
  ownerResponsibilities: ["insurance"],
  alvillasResponsibilities: ["guest operations"],
  specialConditions: ["summer staffing"],
  reason: "Signed amendment with new effective terms"
};
const validBookingChannelInput = {
  propertyId: "00000000-0000-7000-8000-000000000100",
  sourceKey: "airbnb listing",
  displayName: "Airbnb Palmeraie",
  externalListingId: "airbnb-123",
  listingUrl: "https://www.airbnb.com/rooms/123",
  syncMode: "ICAL",
  importEnabled: true,
  exportEnabled: false,
  syncEndpointUrl: "https://calendar.airbnb.com/ical/private-token.ics",
  status: "ACTIVE"
};

describe("core service authorization", () => {
  it("denies owner reads when the actor has no owner permission", async () => {
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set(),
      scopes: [{ organizationId: "org-a" }]
    });

    await expect(listOwners(ctx, { db: deniedDb })).rejects.toBeInstanceOf(CoreAuthorizationError);
  });

  it("denies owner creation before validation reaches the repository", async () => {
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("owner", "view")]),
      scopes: [{ organizationId: "org-a" }]
    });

    await expect(
      createOwner(
        ctx,
        {
          displayName: "Denied Owner",
          preferredLocale: "en",
          representatives: [],
          payoutMethods: []
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(CoreAuthorizationError);
  });

  it("denies property reads outside the actor resource scope", async () => {
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [
        {
          organizationId: "org-a",
          resourceType: "property",
          resourceId: "00000000-0000-7000-8000-000000000010"
        }
      ]
    });

    await expect(
      getProperty(ctx, "00000000-0000-7000-8000-000000000011", { db: deniedDb })
    ).rejects.toBeInstanceOf(CoreAuthorizationError);
  });

  it("validates multi-owner share sets before they reach the repository", () => {
    const valid = parsePropertyOwnershipInput({
      propertyId: "00000000-0000-7000-8000-000000000100",
      shares: [
        {
          ownerId: "00000000-0000-7000-8000-000000000101",
          shareBps: 6000,
          isPrimary: true
        },
        {
          ownerId: "00000000-0000-7000-8000-000000000102",
          shareBps: 4000,
          isPrimary: false
        }
      ]
    });
    const invalid = parsePropertyOwnershipInput({
      propertyId: "00000000-0000-7000-8000-000000000100",
      shares: [
        {
          ownerId: "00000000-0000-7000-8000-000000000101",
          shareBps: 6000,
          isPrimary: true
        },
        {
          ownerId: "00000000-0000-7000-8000-000000000101",
          shareBps: 3000,
          isPrimary: false
        }
      ]
    });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });

  it("denies ownership updates without property edit permission", async () => {
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a" }]
    });

    await expect(
      updatePropertyOwnership(
        ctx,
        {
          propertyId: "00000000-0000-7000-8000-000000000100",
          shares: [
            {
              ownerId: "00000000-0000-7000-8000-000000000101",
              shareBps: 10000,
              isPrimary: true
            }
          ]
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(CoreAuthorizationError);
  });

  it("validates operating profile rules without embedding mid-stay night thresholds", () => {
    const valid = parsePropertyOperatingProfileInput({
      cleaningEnabled: true,
      cleaningFrequency: "BETWEEN_STAYS",
      inspectionEnabled: true,
      inspectionFrequency: "CHECKOUT",
      poolServiceEnabled: true,
      poolServiceFrequency: "DAILY",
      gardenServiceEnabled: false,
      gardenServiceFrequency: "NONE",
      laundryManaged: true,
      linenManaged: true,
      maintenanceTrackingEnabled: true,
      preventiveMaintenanceFrequency: "ON_DEMAND",
      midStayCleaningEnabled: true,
      midStayCleaningRuleKey: "ops.mid_stay_threshold",
      breakfastAvailable: true,
      chefAvailable: true,
      transfersAvailable: true,
      groceriesAvailable: false,
      wellnessAvailable: false,
      otherServices: ["hammam"]
    });
    const invalidMidStay = parsePropertyOperatingProfileInput({
      cleaningEnabled: true,
      cleaningFrequency: "BETWEEN_STAYS",
      inspectionEnabled: true,
      inspectionFrequency: "CHECKOUT",
      poolServiceEnabled: false,
      poolServiceFrequency: "NONE",
      gardenServiceEnabled: false,
      gardenServiceFrequency: "NONE",
      laundryManaged: true,
      linenManaged: true,
      maintenanceTrackingEnabled: true,
      preventiveMaintenanceFrequency: "ON_DEMAND",
      midStayCleaningEnabled: true,
      breakfastAvailable: false,
      chefAvailable: false,
      transfersAvailable: false,
      groceriesAvailable: false,
      wellnessAvailable: false,
      otherServices: []
    });

    expect(valid.success).toBe(true);
    expect(valid.success && valid.data.midStayCleaningRuleKey).toBe("ops.mid_stay_threshold");
    expect(invalidMidStay.success).toBe(false);
  });

  it("denies operating profile updates without property edit permission", async () => {
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a" }]
    });

    await expect(
      updatePropertyOperatingProfile(
        ctx,
        "00000000-0000-7000-8000-000000000100",
        {
          cleaningEnabled: true,
          cleaningFrequency: "BETWEEN_STAYS",
          inspectionEnabled: true,
          inspectionFrequency: "CHECKOUT",
          poolServiceEnabled: false,
          poolServiceFrequency: "NONE",
          gardenServiceEnabled: false,
          gardenServiceFrequency: "NONE",
          laundryManaged: true,
          linenManaged: true,
          maintenanceTrackingEnabled: true,
          preventiveMaintenanceFrequency: "ON_DEMAND",
          midStayCleaningEnabled: false,
          breakfastAvailable: false,
          chefAvailable: false,
          transfersAvailable: false,
          groceriesAvailable: false,
          wellnessAvailable: false,
          otherServices: []
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(CoreAuthorizationError);
  });

  it("validates property lifecycle transitions and reasons", () => {
    const valid = parsePropertyLifecycleTransitionInput({
      propertyId: "00000000-0000-7000-8000-000000000100",
      status: "ONBOARDING",
      reason: "Owner onboarding dossier opened"
    });
    const invalidReason = parsePropertyLifecycleTransitionInput({
      propertyId: "00000000-0000-7000-8000-000000000100",
      status: "ACTIVE",
      reason: "short"
    });

    expect(valid.success).toBe(true);
    expect(invalidReason.success).toBe(false);
    expect(allowedPropertyLifecycleTransitions("DRAFT")).toEqual(["ONBOARDING"]);
    expect(allowedPropertyLifecycleTransitions("PAUSED")).toEqual(["ACTIVE", "OFFBOARDED"]);
    expect(allowedPropertyLifecycleTransitions("OFFBOARDED")).toEqual([]);
  });

  it("denies property lifecycle changes without property edit permission", async () => {
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a" }]
    });

    await expect(
      transitionPropertyLifecycle(
        ctx,
        {
          propertyId: "00000000-0000-7000-8000-000000000100",
          status: "ONBOARDING",
          reason: "Owner onboarding dossier opened"
        },
        { db: deniedDb }
      )
    ).rejects.toBeInstanceOf(CoreAuthorizationError);
  });

  it("validates booking channel configuration and normalizes source keys", () => {
    const valid = parseBookingChannelInput(validBookingChannelInput);
    const invalidSource = parseBookingChannelInput({
      ...validBookingChannelInput,
      sourceKey: "--"
    });
    const invalidUrl = parseBookingChannelInput({
      ...validBookingChannelInput,
      listingUrl: "not-a-url"
    });

    expect(valid.success).toBe(true);
    expect(valid.success && valid.data.sourceKey).toBe("AIRBNB_LISTING");
    expect(valid.success && valid.data.importEnabled).toBe(true);
    expect(invalidSource.success).toBe(false);
    expect(invalidUrl.success).toBe(false);
  });

  it("denies booking channel updates without property edit permission", async () => {
    const parsed = parseBookingChannelInput(validBookingChannelInput);
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "view")]),
      scopes: [{ organizationId: "org-a" }]
    });

    if (!parsed.success) {
      throw new Error("booking channel fixture should parse");
    }

    await expect(upsertPropertyBookingChannel(ctx, parsed.data, { db: deniedDb })).rejects.toBeInstanceOf(
      CoreAuthorizationError
    );
  });

  it("validates management agreements as config-backed rule bundles", () => {
    const valid = parseManagementAgreementInput(validManagementAgreementInput);
    const invalidRange = parseManagementAgreementInput({
      ...validManagementAgreementInput,
      effectiveTo: "2026-01-01T00:00:00.000Z"
    });
    const invalidCommission = parseManagementAgreementInput({
      ...validManagementAgreementInput,
      commissionRateBps: "10001"
    });

    expect(valid.success).toBe(true);
    expect(valid.success && valid.data.approvalThresholdCurrency).toBe("MAD");
    expect(valid.success && valid.data.approvalRequires).toEqual(["manager", "owner"]);
    expect(invalidRange.success).toBe(false);
    expect(invalidCommission.success).toBe(false);
  });

  it("validates management agreement amendments as effective-dated terms", () => {
    const valid = parseManagementAgreementAmendmentInput(validManagementAgreementAmendmentInput);
    const invalidRange = parseManagementAgreementAmendmentInput({
      ...validManagementAgreementAmendmentInput,
      effectiveTo: "2026-05-01T00:00:00.000Z"
    });

    expect(valid.success).toBe(true);
    expect(valid.success && valid.data.approvalThresholdCurrency).toBe("MAD");
    expect(invalidRange.success).toBe(false);
  });

  it("denies management agreement creation without config permissions before reaching the database", async () => {
    const parsed = parseManagementAgreementInput(validManagementAgreementInput);
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "edit")]),
      scopes: [{ organizationId: "org-a" }]
    });

    if (!parsed.success) {
      throw new Error("management agreement fixture should parse");
    }

    await expect(createManagementAgreement(ctx, parsed.data, { db: deniedDb })).rejects.toBeInstanceOf(
      CoreAuthorizationError
    );
  });

  it("denies management agreement amendments without config permissions before reaching the database", async () => {
    const parsed = parseManagementAgreementAmendmentInput(validManagementAgreementAmendmentInput);
    const ctx = actor({
      organizationId: "org-a",
      permissions: new Set([permissionKey("property", "edit")]),
      scopes: [{ organizationId: "org-a" }]
    });

    if (!parsed.success) {
      throw new Error("management agreement amendment fixture should parse");
    }

    await expect(amendManagementAgreement(ctx, parsed.data, { db: deniedDb })).rejects.toBeInstanceOf(
      CoreAuthorizationError
    );
  });
});
