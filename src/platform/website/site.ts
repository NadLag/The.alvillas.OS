import { appLocales } from "@/i18n/routing";

export const publicWebsiteBrand = "ALVILLAS";
export const publicWebsiteOrigin = "https://alvillas.com";
export const publicWebsitePaths = ["", "/management", "/services", "/about", "/assessment"] as const;
export type PublicWebsitePath = typeof publicWebsitePaths[number];

export function publicLanguageUrls(path: PublicWebsitePath) {
  return Object.fromEntries(appLocales.map(locale => [locale, `${publicWebsiteOrigin}/${locale}${path}`]));
}
