import { z } from "zod";
import type { AppLocale } from "@/i18n/routing";

const localeSchema = z.enum(["en", "fr", "ar"]);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(max).optional()
  );
const optionalEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .email()
    .transform((email) => email.toLowerCase())
    .optional()
);
const optionalHttpsUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .url()
    .refine((value) => new URL(value).protocol === "https:", "URL must use HTTPS")
    .optional()
);
const currencySchema = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase());
const countryCodeSchema = z
  .string()
  .trim()
  .length(2)
  .transform((value) => value.toUpperCase());
const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9A-Fa-f]{6}$/u)
  .transform((value) => value.toUpperCase());

export const organizationSettingsInputSchema = z.object({
  name: requiredText(160),
  legalName: optionalText(220),
  brandName: requiredText(160),
  baseCurrency: currencySchema.default("MAD"),
  logoUrl: optionalHttpsUrl,
  primaryColor: colorSchema.default("#0B6B5F"),
  accentColor: colorSchema.default("#9F3F1B"),
  websiteUrl: optionalHttpsUrl,
  supportEmail: optionalEmail,
  supportPhone: optionalText(60),
  defaultLocale: localeSchema.default("fr"),
  timezone: requiredText(80).default("Africa/Casablanca"),
  countryCode: countryCodeSchema.default("MA"),
  fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).default(1)
});

export type OrganizationSettingsInput = z.infer<typeof organizationSettingsInputSchema>;

export type OrganizationSettingsSummary = OrganizationSettingsInput & {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  baseCurrencyLocked: boolean;
  defaultLocale: AppLocale;
};
