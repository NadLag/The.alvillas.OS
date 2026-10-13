import { describe, expect, it } from "vitest";
import type { OrganizationActorContext } from "@/modules/organization/application/organization-access";
import { OrganizationAuthorizationError } from "@/modules/organization/application/organization-access";
import {
  getOrganizationSettings,
  parseOrganizationSettingsInput,
  updateOrganizationSettings
} from "@/modules/organization/application/organization-service";
import { permissionKey, type AuthContext } from "@/platform/authz/authorize";
import type { TenantTransactionRunner } from "@/platform/db/tenant";

const deniedDb: TenantTransactionRunner = {
  $transaction() {
    return Promise.reject(new Error("database should not be reached for denied organization access"));
  }
};

function actor(authContext: AuthContext): OrganizationActorContext {
  return {
    organizationId: authContext.organizationId,
    actorId: "018f0a0b-0000-7000-9000-000000000801",
    personId: "018f0a0b-0000-7000-9000-000000000802",
    authContext
  };
}

describe("organization service authorization and validation", () => {
  it("denies organization reads before reaching the repository", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set(),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });

    await expect(getOrganizationSettings(ctx, { db: deniedDb })).rejects.toBeInstanceOf(
      OrganizationAuthorizationError
    );
  });

  it("denies organization updates before reaching the repository", async () => {
    const ctx = actor({
      organizationId: "018f0a0b-0000-7000-9000-000000000001",
      permissions: new Set([permissionKey("organization", "view")]),
      scopes: [{ organizationId: "018f0a0b-0000-7000-9000-000000000001" }]
    });
    const parsed = parseOrganizationSettingsInput({
      name: "ALVILLAS SARL",
      brandName: "ALVILLAS",
      baseCurrency: "MAD",
      primaryColor: "#0B6B5F",
      accentColor: "#9F3F1B",
      defaultLocale: "fr",
      timezone: "Africa/Casablanca",
      countryCode: "MA",
      fiscalYearStartMonth: 1
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    await expect(updateOrganizationSettings(ctx, parsed.data, { db: deniedDb })).rejects.toBeInstanceOf(
      OrganizationAuthorizationError
    );
  });

  it("normalizes configured currency, country and support email", () => {
    const parsed = parseOrganizationSettingsInput({
      name: "ALVILLAS SARL",
      brandName: "ALVILLAS",
      baseCurrency: "mad",
      primaryColor: "#0b6b5f",
      accentColor: "#9f3f1b",
      supportEmail: "SUPPORT@ALVILLAS.COM",
      defaultLocale: "fr",
      timezone: "Africa/Casablanca",
      countryCode: "ma",
      fiscalYearStartMonth: "1"
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }

    expect(parsed.data).toMatchObject({
      accentColor: "#9F3F1B",
      baseCurrency: "MAD",
      countryCode: "MA",
      primaryColor: "#0B6B5F",
      supportEmail: "support@alvillas.com"
    });
  });
});
