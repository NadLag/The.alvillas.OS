"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";
import { agreementActorContextFromSession, coreActorContextFromSession } from "@/modules/core/application/core-access";
import {
  amendManagementAgreement,
  CoreAuthorizationError,
  CoreNotFoundError,
  CoreValidationError,
  createManagementAgreement,
  createOwner,
  createProperty,
  parseBookingChannelInput,
  parseManagementAgreementAmendmentInput,
  parseManagementAgreementInput,
  parseOwnerInput,
  parsePropertyLifecycleTransitionInput,
  parsePropertyOperatingProfileInput,
  parsePropertyInput,
  parsePropertyOwnershipInput,
  transitionPropertyLifecycle,
  updatePropertyOperatingProfile,
  updatePropertyOwnership,
  upsertPropertyBookingChannel
} from "@/modules/core/application/core-service";
import {
  normalizeAmenities,
  normalizeAgreementTextList,
  normalizeHouseRules,
  normalizeOtherServices,
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

  if (error instanceof CoreValidationError) {
    return { status: "error", messageKey: "validation" };
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

function operatingProfileInput(formData: FormData) {
  return {
    cleaningEnabled: checkboxValue(formData, "cleaningEnabled"),
    cleaningFrequency: formValue(formData, "cleaningFrequency") ?? "NONE",
    inspectionEnabled: checkboxValue(formData, "inspectionEnabled"),
    inspectionFrequency: formValue(formData, "inspectionFrequency") ?? "NONE",
    poolServiceEnabled: checkboxValue(formData, "poolServiceEnabled"),
    poolServiceFrequency: formValue(formData, "poolServiceFrequency") ?? "NONE",
    gardenServiceEnabled: checkboxValue(formData, "gardenServiceEnabled"),
    gardenServiceFrequency: formValue(formData, "gardenServiceFrequency") ?? "NONE",
    laundryManaged: checkboxValue(formData, "laundryManaged"),
    linenManaged: checkboxValue(formData, "linenManaged"),
    maintenanceTrackingEnabled: checkboxValue(formData, "maintenanceTrackingEnabled"),
    preventiveMaintenanceFrequency: formValue(formData, "preventiveMaintenanceFrequency") ?? "NONE",
    midStayCleaningEnabled: checkboxValue(formData, "midStayCleaningEnabled"),
    midStayCleaningRuleKey: formValue(formData, "midStayCleaningRuleKey"),
    breakfastAvailable: checkboxValue(formData, "breakfastAvailable"),
    chefAvailable: checkboxValue(formData, "chefAvailable"),
    transfersAvailable: checkboxValue(formData, "transfersAvailable"),
    groceriesAvailable: checkboxValue(formData, "groceriesAvailable"),
    wellnessAvailable: checkboxValue(formData, "wellnessAvailable"),
    otherServices: normalizeOtherServices(stringValue(formData, "otherServices")),
    automationNotes: formValue(formData, "automationNotes")
  };
}

function approvalRequires(formData: FormData) {
  return formData
    .getAll("approvalRequires")
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function managementAgreementInput(propertyId: string, formData: FormData) {
  return {
    propertyId,
    reference: formValue(formData, "reference"),
    status: formValue(formData, "status") ?? "ACTIVE",
    effectiveFrom: formValue(formData, "effectiveFrom"),
    effectiveTo: formValue(formData, "effectiveTo"),
    commissionRateBps: formValue(formData, "commissionRateBps"),
    commissionBasis: formValue(formData, "commissionBasis"),
    commissionAccrualEvent: formValue(formData, "commissionAccrualEvent"),
    expenseDefaultTreatment: formValue(formData, "expenseDefaultTreatment"),
    approvalThresholdKey: formValue(formData, "approvalThresholdKey"),
    approvalThresholdAmount: formValue(formData, "approvalThresholdAmount"),
    approvalThresholdCurrency: formValue(formData, "approvalThresholdCurrency") ?? "MAD",
    approvalRequires: approvalRequires(formData),
    payoutCadence: formValue(formData, "payoutCadence"),
    payoutHoldDays: formValue(formData, "payoutHoldDays"),
    payoutHoldbackBps: formValue(formData, "payoutHoldbackBps"),
    noticePeriodDays: formValue(formData, "noticePeriodDays"),
    ownerResponsibilities: normalizeAgreementTextList(stringValue(formData, "ownerResponsibilities")),
    alvillasResponsibilities: normalizeAgreementTextList(stringValue(formData, "alvillasResponsibilities")),
    specialConditions: normalizeAgreementTextList(stringValue(formData, "specialConditions")),
    reason: formValue(formData, "reason")
  };
}

function managementAgreementAmendmentInput(propertyId: string, agreementId: string, formData: FormData) {
  return {
    ...managementAgreementInput(propertyId, formData),
    agreementId
  };
}

function bookingChannelInput(propertyId: string, formData: FormData) {
  return {
    propertyId,
    sourceKey: formValue(formData, "sourceKey"),
    displayName: formValue(formData, "displayName"),
    externalListingId: formValue(formData, "externalListingId"),
    listingUrl: formValue(formData, "listingUrl"),
    syncMode: formValue(formData, "syncMode") ?? "MANUAL",
    importEnabled: checkboxValue(formData, "importEnabled"),
    exportEnabled: checkboxValue(formData, "exportEnabled"),
    syncEndpointUrl: formValue(formData, "syncEndpointUrl"),
    status: formValue(formData, "status") ?? "ACTIVE"
  };
}

export async function createOwnerAction(
  locale: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await coreActorContextFromSession(session);

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
  const ctx = await coreActorContextFromSession(session);

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
    operatingProfile: operatingProfileInput(formData),
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

export async function updatePropertyOperatingProfileAction(
  locale: string,
  propertyId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePropertyOperatingProfileInput(operatingProfileInput(formData));

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await updatePropertyOperatingProfile(ctx, propertyId, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties/${propertyId}`);
  revalidatePath(`/${appLocale}/app/properties`);

  return { status: "success" };
}

export async function updatePropertyOwnershipAction(
  locale: string,
  propertyId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePropertyOwnershipInput({
    propertyId,
    reason: formValue(formData, "reason"),
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

export async function transitionPropertyLifecycleAction(
  locale: string,
  propertyId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parsePropertyLifecycleTransitionInput({
    propertyId,
    status: formValue(formData, "status"),
    reason: formValue(formData, "reason")
  });

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await transitionPropertyLifecycle(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties/${propertyId}`);
  revalidatePath(`/${appLocale}/app/properties`);

  return { status: "success" };
}

export async function upsertPropertyBookingChannelAction(
  locale: string,
  propertyId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await coreActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseBookingChannelInput(bookingChannelInput(propertyId, formData));

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await upsertPropertyBookingChannel(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties/${propertyId}`);
  revalidatePath(`/${appLocale}/app/properties`);

  return { status: "success" };
}

export async function createManagementAgreementAction(
  locale: string,
  propertyId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await agreementActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseManagementAgreementInput(managementAgreementInput(propertyId, formData));

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await createManagementAgreement(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties/${propertyId}`);
  revalidatePath(`/${appLocale}/app/properties`);

  return { status: "success" };
}

export async function amendManagementAgreementAction(
  locale: string,
  propertyId: string,
  agreementId: string,
  _state: CoreFormState,
  formData: FormData
): Promise<CoreFormState> {
  const appLocale = safeLocale(locale);
  const session = await auth();
  const ctx = await agreementActorContextFromSession(session);

  if (!ctx) {
    return { status: "error", messageKey: "unauthorized" };
  }

  const parsed = parseManagementAgreementAmendmentInput(
    managementAgreementAmendmentInput(propertyId, agreementId, formData)
  );

  if (!parsed.success) {
    return flattenZodError(parsed.error);
  }

  try {
    await amendManagementAgreement(ctx, parsed.data);
  } catch (error) {
    return actionErrorState(error);
  }

  revalidatePath(`/${appLocale}/app/properties/${propertyId}`);
  revalidatePath(`/${appLocale}/app/properties`);

  return { status: "success" };
}
