import { describe, expect, it } from "vitest";
import type { CoreActorContext } from "@/modules/core/application/core-access";
import {
  CoreAuthorizationError,
  createOwner,
  getProperty,
  listOwners,
  parsePropertyOperatingProfileInput,
  parsePropertyOwnershipInput,
  updatePropertyOperatingProfile,
  updatePropertyOwnership
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
});
