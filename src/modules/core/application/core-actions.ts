"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import { coreActorContextFromSession } from "@/modules/core/application/core-access";
import {
  CoreAuthorizationError,
  CoreNotFoundError,
  createOwner,
  createProperty,
  parseOwnerInput,
  parsePropertyInput,
  parsePropertyOwnershipInput,
  updatePropertyOwnership
} from "@/modules/core/application/core-service";
import {
  normalizeAmenities,
  normalizeHouseRules,
  normalizePhotoUrls
} from "@/modules/core/domain/owner-property";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export type CoreFormState = {
  status: "idle" | "error" | "success";
  messageKey?: "validation" | "unauthorized" | "forbidden" | "notFound" | "generic";
  fieldErrors?: Record<string, string[]>;
};

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function formValue(formData: FormData, key: string): FormDataEntryValue | undefined {
  return formData.get(key) ?? undefined;
}

function stringValue(formData: FormData, key: string): string {
  const value = formValue(formData, key);
  return typeof value === "string" ? value : "";
}

function checkboxValue(formData: FormData, key: string): boolean {
  return formData.get(key) === "on";
}

function sharePercentToBps(value: FormDataEntryValue | undefined): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }

  const trimmed = value.trim();
  const match = /^(?<whole>\d{1,3})(?:\.(?<fraction>\d{1,2}))?$/u.exec(trimmed);

  if (!match?.groups) {
    return Number.NaN;
  }

  const whole = Number.parseInt(match.groups.whole, 10);
  const fraction = Number.parseInt((match.groups.fraction ?? "").padEnd(2, "0"), 10);
  const bps = whole * 100 + fraction;

  return bps <= 10000 ? bps : Number.NaN;
}

function optionalOwnerRepresentatives(formData: FormData) {
  const displayName = stringValue(formData, "representativeDisplayName").trim();

  if (!displayName) {
    return [];
  }

  return [
    {
      displayName,
      email: formValue(formData, "representativeEmail"),
      phone: formValue(formData, "representativePhone"),
      preferredLocale: formValue(formData, "representativePreferredLocale") ?? "fr",
      relationship: formValue(formData, "representativeRelationship"),
      accessNotes: formValue(formData, "representativeAccessNotes"),
      validFrom: formValue(formData, "representativeValidFrom"),
      validTo: formValue(formData, "representativeValidTo")
    }
  ];
}

function optionalPayoutMethods(formData: FormData) {
  const label = stringValue(formData, "payoutLabel").trim();
  const detailsPlaintext = stringValue(formData, "payoutDetails").trim();

  if (!label && !detailsPlaintext) {
    return [];
  }

  return [
    {
      label,
      methodType: formValue(formData, "payoutMethodType") ?? "BANK_TRANSFER",
      accountHolderName: formValue(formData, "payoutAccountHolderName"),
      currency: formValue(formData, "payoutCurrency") ?? "MAD",
      countryCode: formValue(formData, "payoutCountryCode") ?? "MA",
      detailsPlaintext,
      isDefault: checkboxValue(formData, "payoutIsDefault")
    }
  ];
}

function flattenZodError(error: ZodError): CoreFormState {
  return {
    status: "error",
    messageKey: "validation",
    fieldErrors: error.flatten().fieldErrors
  };
}

function actionErrorState(error: unknown): CoreFormState {
  if (error instanceof CoreAuthorizationError) {
    return { status: "error", messageKey: "forbidden" };
  }

  if (error instanceof CoreNotFoundError) {
    return { status: "error", messageKey: "notFound" };
  }

  return { status: "error", messageKey: "generic" };
}

function propertyOwnershipShares(formData: FormData) {
  const ownerIds = formData.getAll("ownershipOwnerId");
  const sharePercents = formData.getAll("ownershipSharePercent");
  const primaryOwnerId = stringValue(formData, "primaryOwnerId");

  return ownerIds.flatMap((ownerId, index) => {
    if (typeof ownerId !== "string" || ownerId.trim() === "") {
      return [];
    }

    return [
      {
        ownerId,
        shareBps: sharePercentToBps(sharePercents[index]),
        isPrimary: ownerId === primaryOwnerId
      }
    ];
  });
}

export async function createOwnerAction(
  locale: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseOwnerInput({
    displayName: formValue(formData, "displayName"),
    legalName: formValue(formData, "legalName"),
    email: formValue(formData, "email"),
    phone: formValue(formData, "phone"),
    preferredLocale: formValue(formData, "preferredLocale"),
    notes: formValue(formData, "notes"),
    representatives: optionalOwnerRepresentatives(formData),
    payoutMethods: optionalPayoutMethods(formData)
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  let ownerId: string;

  try {
    const owner = await createOwner(ctx, parsed.data);
    ownerId = owner.id;
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/owners`);
  redirect(`/${appLocale}/app/owners/${ownerId}`);
}

export async function createPropertyAction(
  locale: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePropertyInput({
    ownerId: formValue(formData, "ownerId"),
    cityId: formValue(formData, "cityId"),
    name: formValue(formData, "name"),
    addressLine1: formValue(formData, "addressLine1"),
    addressLine2: formValue(formData, "addressLine2"),
    city: formValue(formData, "city"),
    region: formValue(formData, "region"),
    countryCode: formValue(formData, "countryCode") ?? "MA",
    propertyType: formValue(formData, "propertyType"),
    bedrooms: formValue(formData, "bedrooms"),
    bathrooms: formValue(formData, "bathrooms"),
    livingSpaces: formValue(formData, "livingSpaces") ?? "1",
    hasPool: checkboxValue(formData, "hasPool"),
    hasGarden: checkboxValue(formData, "hasGarden"),
    parkingSpaces: formValue(formData, "parkingSpaces") ?? "0",
    maxGuests: formValue(formData, "maxGuests"),
    timezone: formValue(formData, "timezone") ?? "Africa/Casablanca",
    amenities: normalizeAmenities(stringValue(formData, "amenities")),
    photoUrls: normalizePhotoUrls(stringValue(formData, "photoUrls")),
    status: "DRAFT",
    onboardingProfile: {
      headline: formValue(formData, "headline"),
      description: formValue(formData, "description"),
      publicDirections: formValue(formData, "publicDirections"),
      internalAccessNotes: formValue(formData, "internalAccessNotes"),
      houseRules: normalizeHouseRules(stringValue(formData, "houseRules")),
      onboardingNotes: formValue(formData, "onboardingNotes")
    }
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  let propertyId: string;

  try {
    const property = await createProperty(ctx, parsed.data);
    propertyId = property.id;
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties`);
  redirect(`/${appLocale}/app/properties/${propertyId}`);
}

export async function updatePropertyOwnershipAction(
  locale: string,
  propertyId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePropertyOwnershipInput({
    propertyId,
    shares: propertyOwnershipShares(formData)
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await updatePropertyOwnership(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties/${propertyId}`);
  revalidatePath(`/${appLocale}/app/properties`);

  return { status: "success" };
}
