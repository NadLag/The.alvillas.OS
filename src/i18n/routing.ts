import { defineRouting } from "next-intl/routing";

export const appLocales = ["en", "fr", "ar"] as const;

export const routing = defineRouting({
  locales: appLocales,
  defaultLocale: "en",
  localePrefix: "always"
});

export type AppLocale = (typeof appLocales)[number];

export const appLocaleSet = new Set<string>(appLocales);

export const localeLabels: Record<AppLocale, string> = {
  en: "English",
  fr: "Francais",
  ar: "AR"
};

export const compactLocaleLabels: Record<AppLocale, string> = {
  en: "EN",
  fr: "FR",
  ar: "AR"
};

export function isAppLocale(locale: string): locale is AppLocale {
  return appLocaleSet.has(locale);
}

export function safeLocale(locale: string | null | undefined): AppLocale {
  return locale && isAppLocale(locale) ? locale : routing.defaultLocale;
}

export function localeDirection(locale: AppLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}
