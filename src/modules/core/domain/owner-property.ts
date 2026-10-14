import { z } from "zod";

const localeSchema = z.enum(["en", "fr", "ar"]);

const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );

const requiredText = (max: number) => z.string().trim().min(1).max(max);

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

export const propertyOnboardingProfileInputSchema = z.object({
  headline: optionalText(180),
  description: optionalText(2000),
  publicDirections: optionalText(1200),
  internalAccessNotes: optionalText(1200),
  houseRules: z.array(z.string().trim().min(1).max(180)).max(30).default([]),
  onboardingNotes: optionalText(2000)
});

export type PropertyOnboardingProfileInput = z.infer<typeof propertyOnboardingProfileInputSchema>;

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
    onboardingProfile: propertyOnboardingProfileInputSchema.default({ houseRules: [] })
  })
  .refine((value) => Boolean(value.cityId || value.city), {
    message: "City is required",
    path: ["city"]
  });

export type PropertyInput = z.infer<typeof propertyInputSchema>;

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
  maxGuests: number;
  timezone: string;
  status: z.infer<typeof propertyStatusSchema>;
  hasPool: boolean;
  hasGarden: boolean;
  amenities: string[];
  photoUrls: string[];
  onboardingProfile: PropertyOnboardingProfileSummary | null;
  owners: Array<{
    id: string;
    displayName: string;
    shareBps: number;
    isPrimary: boolean;
  }>;
  createdAt: Date;
};
