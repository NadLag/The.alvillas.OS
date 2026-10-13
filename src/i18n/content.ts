import { z } from "zod";
import { appLocales, safeLocale, type AppLocale } from "@/i18n/routing";

const localizedRequired = z.string().trim().min(1).max(240);
const localizedOptional = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).max(240).optional()
);

export const localizedTextSchema = z.object({
  en: localizedRequired,
  fr: localizedRequired,
  ar: localizedOptional
});

export const multilingualCatalogContentSchema = z.object({
  key: z.string().trim().min(1).max(120).regex(/^[a-z0-9_.-]+$/u),
  name: localizedTextSchema,
  description: localizedTextSchema.optional()
});

export type LocalizedText = z.infer<typeof localizedTextSchema>;
export type MultilingualCatalogContent = z.infer<typeof multilingualCatalogContentSchema>;

export function localizedText(value: Record<string, string>, locale: AppLocale): string {
  return value[locale] ?? value.en ?? value.fr ?? Object.values(value)[0] ?? "";
}

export function assertLocalizedTextCoverage(value: Record<string, unknown>, label: string): void {
  const parsed = localizedTextSchema.safeParse(value);

  if (!parsed.success) {
    throw new Error(`${label} must include EN and FR text with optional AR text`);
  }
}

export function localizedRoute(path: string, locale: string | null | undefined): string {
  const appLocale = safeLocale(locale);
  const normalized = path.startsWith("/") ? path : `/${path}`;

  return `/${appLocale}${normalized}`;
}

export function localeAlternates(path: string): Array<{ locale: AppLocale; href: string }> {
  const normalized = path.startsWith("/") ? path : `/${path}`;

  return appLocales.map((locale) => ({ locale, href: `/${locale}${normalized}` }));
}
