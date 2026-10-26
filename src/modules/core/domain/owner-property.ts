import { z } from "zod";
import {
  approvalStepSchema,
  commissionAccrualEventSchema,
  commissionBasisSchema,
  expenseTreatmentSchema,
  payoutCadenceSchema
} from "@/platform/config/rule-registry";

const localeSchema = z.enum(["en", "fr", "ar"]);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );

const requiredText = (max: number) => z.string().trim().min(1).max(max);

const optionalUrl = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().url().max(max).optional()
  );

const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .email()
    .max(320)
    .transform((value) => value.toLowerCase())
    .optional()
);

const optionalDate = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.date().optional()
);

const nonNegativeInteger = z.coerce.number().int().min(0);
const positiveInteger = z.coerce.number().int().min(1);
const positiveShareBps = z.coerce.number().int().min(1).max(10000);
const optionalNonNegativeInteger = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.number().int().min(0).optional()
);
const optionalBps = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.coerce.number().int().min(0).max(10000).optional()
);
const configRuleKey = z.string().trim().min(1).max(120).regex(/^[a-z0-9_.-]+$/u);
const moneyAmountText = z
  .string()
  .trim()
  .regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u, "Use a money amount with up to 2 decimals");
const optionalMoneyAmountText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  moneyAmountText.optional()
);

export const payoutMethodTypeSchema = z.enum([
  "BANK_TRANSFER",
  "WISE",
  "CASH",
  "CHEQUE",
  "OTHER"
]);

export const ownerRepresentativeInputSchema = z
  .object({
    displayName: requiredText(160),
    email: optionalEmail,
    phone: optionalText(60),
    preferredLocale: localeSchema.default("fr"),
    relationship: optionalText(120),
    accessNotes: optionalText(500),
    validFrom: optionalDate,
    validTo: optionalDate
  })
  .refine(
    (value) =>
      !value.validFrom || !value.validTo || value.validTo.getTime() > value.validFrom.getTime(),
    "Representative end date must be after the start date"
  );

export const ownerPayoutMethodInputSchema = z.object({
  label: requiredText(120),
  methodType: payoutMethodTypeSchema.default("BANK_TRANSFER"),
  accountHolderName: requiredText(160),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase())
    .default("MAD"),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .default("MA"),
  detailsPlaintext: requiredText(2000),
  isDefault: z.coerce.boolean().default(true)
});

export const ownerInputSchema = z.object({
  displayName: requiredText(160),
  legalName: optionalText(220),
  email: optionalEmail,
  phone: optionalText(60),
  preferredLocale: localeSchema.default("fr"),
  notes: optionalText(1000),
  representatives: z.array(ownerRepresentativeInputSchema).max(12).default([]),
  payoutMethods: z.array(ownerPayoutMethodInputSchema).max(8).default([])
});

export type OwnerInput = z.infer<typeof ownerInputSchema>;
export type OwnerRepresentativeInput = z.infer<typeof ownerRepresentativeInputSchema>;
export type OwnerPayoutMethodInput = z.infer<typeof ownerPayoutMethodInputSchema>;

export const propertyStatusSchema = z.enum([
  "DRAFT",
  "ONBOARDING",
  "ACTIVE",
  "PAUSED",
  "OFFBOARDED"
]);
export const propertyLifecycleStatuses = propertyStatusSchema.options;
export type PropertyLifecycleStatus = z.infer<typeof propertyStatusSchema>;

export function normalizeAmenities(value: string | readonly string[] | undefined): string[] {
  const rawItems: string[] = typeof value === "string" ? value.split(",") : [...(value ?? [])];
  const normalized = rawItems
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);

  return normalized.slice(0, 40);
}

export function normalizePhotoUrls(value: string | readonly string[] | undefined): string[] {
  const rawItems: string[] =
    typeof value === "string" ? value.split(/\r?\n|,/u) : [...(value ?? [])];
  const normalized = rawItems
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);

  return normalized.slice(0, 30);
}

export function normalizeHouseRules(value: string | readonly string[] | undefined): string[] {
  const rawItems: string[] =
    typeof value === "string" ? value.split(/\r?\n|,/u) : [...(value ?? [])];
  const normalized = rawItems
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);

  return normalized.slice(0, 30);
}

export function normalizeOtherServices(value: string | readonly string[] | undefined): string[] {
  const rawItems: string[] =
    typeof value === "string" ? value.split(/\r?\n|,/u) : [...(value ?? [])];
  const normalized = rawItems
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);

  return normalized.slice(0, 24);
}

export function normalizeAgreementTextList(value: string | readonly string[] | undefined): string[] {
  const rawItems: string[] =
    typeof value === "string" ? value.split(/\r?\n|,/u) : [...(value ?? [])];
  const normalized = rawItems
    .map((item) => item.trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);

  return normalized.slice(0, 80);
}

export const propertyOnboardingProfileInputSchema = z.object({
  headline: optionalText(180),
  description: optionalText(2000),
  publicDirections: optionalText(1200),
  internalAccessNotes: optionalText(1200),
  houseRules: z.array(z.string().trim().min(1).max(180)).max(30).default([]),
  onboardingNotes: optionalText(2000)
});

export type PropertyOnboardingProfileInput = z.infer<typeof propertyOnboardingProfileInputSchema>;

export const operatingCadenceSchema = z.enum([
  "NONE",
  "ON_DEMAND",
  "BETWEEN_STAYS",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "CHECKIN",
  "CHECKOUT",
  "CUSTOM_RULE"
]);

function cadenceFor(enabledKey: string, cadenceKey: string) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
    if (value[enabledKey] === true && value[cadenceKey] === "NONE") {
      ctx.addIssue({
        code: "custom",
        message: "Select an operating cadence when the service is enabled",
        path: [cadenceKey]
      });
    }
  };
}

export const propertyOperatingProfileInputSchema = z
  .object({
    cleaningEnabled: z.coerce.boolean().default(true),
    cleaningFrequency: operatingCadenceSchema.default("BETWEEN_STAYS"),
    inspectionEnabled: z.coerce.boolean().default(true),
    inspectionFrequency: operatingCadenceSchema.default("CHECKOUT"),
    poolServiceEnabled: z.coerce.boolean().default(false),
    poolServiceFrequency: operatingCadenceSchema.default("NONE"),
    gardenServiceEnabled: z.coerce.boolean().default(false),
    gardenServiceFrequency: operatingCadenceSchema.default("NONE"),
    laundryManaged: z.coerce.boolean().default(true),
    linenManaged: z.coerce.boolean().default(true),
    maintenanceTrackingEnabled: z.coerce.boolean().default(true),
    preventiveMaintenanceFrequency: operatingCadenceSchema.default("ON_DEMAND"),
    midStayCleaningEnabled: z.coerce.boolean().default(false),
    midStayCleaningRuleKey: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      configRuleKey.optional()
    ),
    breakfastAvailable: z.coerce.boolean().default(false),
    chefAvailable: z.coerce.boolean().default(false),
    transfersAvailable: z.coerce.boolean().default(false),
    groceriesAvailable: z.coerce.boolean().default(false),
    wellnessAvailable: z.coerce.boolean().default(false),
    otherServices: z.array(z.string().trim().min(1).max(120)).max(24).default([]),
    automationNotes: optionalText(2000)
  })
  .superRefine((value, ctx) => {
    cadenceFor("cleaningEnabled", "cleaningFrequency")(value, ctx);
    cadenceFor("inspectionEnabled", "inspectionFrequency")(value, ctx);
    cadenceFor("poolServiceEnabled", "poolServiceFrequency")(value, ctx);
    cadenceFor("gardenServiceEnabled", "gardenServiceFrequency")(value, ctx);

    if (value.maintenanceTrackingEnabled && value.preventiveMaintenanceFrequency === "NONE") {
      ctx.addIssue({
        code: "custom",
        message: "Select a preventive maintenance cadence when maintenance tracking is enabled",
        path: ["preventiveMaintenanceFrequency"]
      });
    }

    if (value.midStayCleaningEnabled && !value.midStayCleaningRuleKey) {
      ctx.addIssue({
        code: "custom",
        message: "Select the config rule that controls mid-stay cleaning nights",
        path: ["midStayCleaningRuleKey"]
      });
    }
  });

export type PropertyOperatingProfileInput = z.infer<typeof propertyOperatingProfileInputSchema>;

export const managementAgreementStatusSchema = z.enum(["DRAFT", "ACTIVE", "ENDED"]);

const managementAgreementTermFields = {
  effectiveFrom: z.coerce.date(),
  effectiveTo: optionalDate,
  commissionRateBps: z.coerce.number().int().min(0).max(10000),
  commissionBasis: commissionBasisSchema,
  commissionAccrualEvent: commissionAccrualEventSchema,
  expenseDefaultTreatment: expenseTreatmentSchema,
  approvalThresholdKey: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    configRuleKey.optional()
  ),
  approvalThresholdAmount: optionalMoneyAmountText,
  approvalThresholdCurrency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase())
    .default("MAD"),
  approvalRequires: z.array(approvalStepSchema).min(1).default(["owner"]),
  payoutCadence: payoutCadenceSchema,
  payoutHoldDays: optionalNonNegativeInteger,
  payoutHoldbackBps: optionalBps,
  noticePeriodDays: z.coerce.number().int().min(0).max(1095),
  ownerResponsibilities: z.array(z.string().trim().min(1).max(240)).max(40).default([]),
  alvillasResponsibilities: z.array(z.string().trim().min(1).max(240)).max(40).default([]),
  specialConditions: z.array(z.string().trim().min(1).max(240)).max(80).default([]),
  reason: requiredText(500)
} as const;

function validManagementAgreementDateRange(value: {
  effectiveFrom: Date;
  effectiveTo?: Date | null;
}): boolean {
  return !value.effectiveTo || value.effectiveTo.getTime() > value.effectiveFrom.getTime();
}

export const managementAgreementInputSchema = z
  .object({
    propertyId: z.string().uuid(),
    reference: requiredText(160),
    status: managementAgreementStatusSchema.default("ACTIVE"),
    ...managementAgreementTermFields
  })
  .refine(validManagementAgreementDateRange, {
    message: "Agreement end date must be after the effective date",
    path: ["effectiveTo"]
  });

export type ManagementAgreementInput = z.infer<typeof managementAgreementInputSchema>;

export const managementAgreementAmendmentInputSchema = z
  .object({
    propertyId: z.string().uuid(),
    agreementId: z.string().uuid(),
    ...managementAgreementTermFields
  })
  .refine(validManagementAgreementDateRange, {
    message: "Agreement end date must be after the effective date",
    path: ["effectiveTo"]
  });

export type ManagementAgreementAmendmentInput = z.infer<typeof managementAgreementAmendmentInputSchema>;

export type ManagementAgreementRuleSummary = {
  id: string;
  key: string;
  version: number;
  lifecycle: "DRAFT" | "ACTIVE" | "RETIRED";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  reason: string;
  createdAt: Date;
  value: Record<string, unknown>;
};

export type ManagementAgreementSummary = {
  id: string;
  propertyId: string;
  reference: string;
  status: "DRAFT" | "ACTIVE" | "ENDED";
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
  rules: ManagementAgreementRuleSummary[];
};

export function defaultPropertyOperatingProfile(input: {
  hasPool?: boolean;
  hasGarden?: boolean;
} = {}): PropertyOperatingProfileInput {
  return {
    cleaningEnabled: true,
    cleaningFrequency: "BETWEEN_STAYS",
    inspectionEnabled: true,
    inspectionFrequency: "CHECKOUT",
    poolServiceEnabled: Boolean(input.hasPool),
    poolServiceFrequency: input.hasPool ? "ON_DEMAND" : "NONE",
    gardenServiceEnabled: Boolean(input.hasGarden),
    gardenServiceFrequency: input.hasGarden ? "ON_DEMAND" : "NONE",
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
  };
}

export const propertyInputSchema = z
  .object({
    ownerId: z.string().uuid(),
    cityId: z.preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().uuid().optional()
    ),
    name: requiredText(160),
    addressLine1: requiredText(240),
    addressLine2: optionalText(240),
    city: optionalText(120),
    region: optionalText(120),
    countryCode: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .default("MA"),
    propertyType: requiredText(80),
    bedrooms: nonNegativeInteger,
    bathrooms: nonNegativeInteger,
    livingSpaces: nonNegativeInteger.default(1),
    hasPool: z.coerce.boolean().default(false),
    hasGarden: z.coerce.boolean().default(false),
    parkingSpaces: nonNegativeInteger.default(0),
    maxGuests: positiveInteger,
    timezone: requiredText(80).default("Africa/Casablanca"),
    amenities: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
    photoUrls: z.array(z.string().url()).max(30).default([]),
    status: propertyStatusSchema.default("DRAFT"),
    operatingProfile: propertyOperatingProfileInputSchema.default({
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
    }),
    onboardingProfile: propertyOnboardingProfileInputSchema.default({ houseRules: [] })
  })
  .refine((value) => Boolean(value.cityId || value.city), {
    message: "City is required",
    path: ["city"]
  });

export type PropertyInput = Omit<z.infer<typeof propertyInputSchema>, "operatingProfile"> & {
  operatingProfile?: PropertyOperatingProfileInput;
};

export const propertyOwnershipShareInputSchema = z.object({
  ownerId: z.string().uuid(),
  shareBps: positiveShareBps,
  isPrimary: z.coerce.boolean().default(false)
});

export const propertyOwnershipInputSchema = z
  .object({
    propertyId: z.string().uuid(),
    reason: z.string().trim().min(6).max(500),
    shares: z.array(propertyOwnershipShareInputSchema).min(1).max(20)
  })
  .superRefine((value, ctx) => {
    const ownerIds = new Set<string>();
    let primaryCount = 0;
    let totalShareBps = 0;

    value.shares.forEach((share, index) => {
      if (ownerIds.has(share.ownerId)) {
        ctx.addIssue({
          code: "custom",
          message: "Each owner can only appear once",
          path: ["shares", index, "ownerId"]
        });
      }
      ownerIds.add(share.ownerId);
      totalShareBps += share.shareBps;
      primaryCount += share.isPrimary ? 1 : 0;
    });

    if (totalShareBps !== 10000) {
      ctx.addIssue({
        code: "custom",
        message: "Ownership shares must total 100%",
        path: ["shares"]
      });
    }

    if (primaryCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "Select exactly one primary owner",
        path: ["shares"]
      });
    }
  });

export type PropertyOwnershipInput = z.infer<typeof propertyOwnershipInputSchema>;

export const propertyLifecycleTransitionInputSchema = z.object({
  propertyId: z.string().uuid(),
  status: propertyStatusSchema,
  reason: z.string().trim().min(6).max(500)
});

export type PropertyLifecycleTransitionInput = z.infer<typeof propertyLifecycleTransitionInputSchema>;

export const bookingChannelStatusSchema = z.enum(["ACTIVE", "PAUSED", "DISCONNECTED"]);
export const bookingChannelSyncModeSchema = z.enum(["MANUAL", "ICAL", "API", "CSV", "CHANNEL_MANAGER"]);
export const bookingChannelSourceKeySchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, ""))
  .refine((value) => /^[A-Z0-9_]{2,40}$/u.test(value), "Use a stable booking source key");

export const bookingChannelInputSchema = z.object({
  propertyId: z.string().uuid(),
  sourceKey: bookingChannelSourceKeySchema,
  displayName: requiredText(120),
  externalListingId: optionalText(160),
  listingUrl: optionalUrl(1000),
  syncMode: bookingChannelSyncModeSchema.default("MANUAL"),
  importEnabled: z.coerce.boolean().default(false),
  exportEnabled: z.coerce.boolean().default(false),
  syncEndpointUrl: optionalUrl(2000),
  status: bookingChannelStatusSchema.default("ACTIVE")
});

export type BookingChannelInput = z.infer<typeof bookingChannelInputSchema>;

export type OwnerRepresentativeSummary = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  preferredLocale: "en" | "fr" | "ar";
  relationship: string | null;
  accessNotes: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  status: "ACTIVE" | "PAUSED" | "REVOKED";
};

export type OwnerPayoutMethodSummary = {
  id: string;
  label: string;
  methodType: z.infer<typeof payoutMethodTypeSchema>;
  accountHolderName: string;
  currency: string;
  countryCode: string;
  maskedAccount: string;
  isDefault: boolean;
  status: "ACTIVE" | "PAUSED" | "REVOKED";
};

export type OwnerSummary = {
  id: string;
  displayName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  preferredLocale: "en" | "fr" | "ar";
  notes: string | null;
  propertyCount: number;
  representatives: OwnerRepresentativeSummary[];
  payoutMethods: OwnerPayoutMethodSummary[];
  createdAt: Date;
};

export type PropertyOnboardingProfileSummary = {
  headline: string | null;
  description: string | null;
  publicDirections: string | null;
  internalAccessNotes: string | null;
  houseRules: string[];
  photoGallery: Array<{
    url: string;
    label: string;
    sortOrder: number;
  }>;
  onboardingChecklist: Record<string, boolean | number | string>;
  onboardingNotes: string | null;
};

export type PropertyOperatingCadence = z.infer<typeof operatingCadenceSchema>;

export type PropertyOperatingProfileSummary = {
  cleaningEnabled: boolean;
  cleaningFrequency: PropertyOperatingCadence;
  inspectionEnabled: boolean;
  inspectionFrequency: PropertyOperatingCadence;
  poolServiceEnabled: boolean;
  poolServiceFrequency: PropertyOperatingCadence;
  gardenServiceEnabled: boolean;
  gardenServiceFrequency: PropertyOperatingCadence;
  laundryManaged: boolean;
  linenManaged: boolean;
  maintenanceTrackingEnabled: boolean;
  preventiveMaintenanceFrequency: PropertyOperatingCadence;
  midStayCleaningEnabled: boolean;
  midStayCleaningRuleKey: string | null;
  breakfastAvailable: boolean;
  chefAvailable: boolean;
  transfersAvailable: boolean;
  groceriesAvailable: boolean;
  wellnessAvailable: boolean;
  otherServices: string[];
  automationNotes: string | null;
};

export type PropertyLifecycleEventSummary = {
  id: string;
  fromStatus: PropertyLifecycleStatus | null;
  toStatus: PropertyLifecycleStatus;
  reason: string | null;
  actorId: string | null;
  occurredAt: Date;
};

export type BookingChannelSummary = {
  id: string;
  propertyId: string;
  sourceKey: string;
  displayName: string;
  externalListingId: string | null;
  listingUrl: string | null;
  syncMode: z.infer<typeof bookingChannelSyncModeSchema>;
  importEnabled: boolean;
  exportEnabled: boolean;
  maskedSyncEndpoint: string | null;
  status: z.infer<typeof bookingChannelStatusSchema>;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncMessage: string | null;
  createdAt: Date;
};

export type PropertySummary = {
  id: string;
  name: string;
  cityId: string;
  regionId: string | null;
  region: string | null;
  city: string;
  propertyType: string;
  bedrooms: number;
  bathrooms: number;
  livingSpaces: number;
  parkingSpaces: number;
  maxGuests: number;
  timezone: string;
  status: z.infer<typeof propertyStatusSchema>;
  hasPool: boolean;
  hasGarden: boolean;
  amenities: string[];
  photoUrls: string[];
  onboardingProfile: PropertyOnboardingProfileSummary | null;
  operatingProfile: PropertyOperatingProfileSummary | null;
  owners: Array<{
    id: string;
    displayName: string;
    shareBps: number;
    isPrimary: boolean;
  }>;
  lifecycleEvents: PropertyLifecycleEventSummary[];
  bookingChannels: BookingChannelSummary[];
  createdAt: Date;
};
