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

const nonNegativeInteger = z.coerce.number().int().min(0);
const positiveInteger = z.coerce.number().int().min(1);

export const ownerInputSchema = z.object({
  displayName: requiredText(160),
  legalName: optionalText(220),
  email: optionalEmail,
  phone: optionalText(60),
  preferredLocale: localeSchema.default("fr"),
  notes: optionalText(1000)
});

export type OwnerInput = z.infer<typeof ownerInputSchema>;

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

export const propertyInputSchema = z.object({
  ownerId: z.string().uuid(),
  name: requiredText(160),
  addressLine1: requiredText(240),
  addressLine2: optionalText(240),
  city: requiredText(120),
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
  status: propertyStatusSchema.default("DRAFT")
});

export type PropertyInput = z.infer<typeof propertyInputSchema>;

export type OwnerSummary = {
  id: string;
  displayName: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  preferredLocale: "en" | "fr" | "ar";
  notes: string | null;
  propertyCount: number;
  createdAt: Date;
};

export type PropertySummary = {
  id: string;
  name: string;
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
  owners: Array<{
    id: string;
    displayName: string;
    shareBps: number;
    isPrimary: boolean;
  }>;
  createdAt: Date;
};
