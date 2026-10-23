import type { MetadataRoute } from "next";
import { localeDirection, type AppLocale } from "@/i18n/routing";

export function fieldManifest(locale: AppLocale, labels: { title: string; description: string }): MetadataRoute.Manifest {
  return { id: "/", name: labels.title, short_name: labels.title, description: labels.description,
    lang: locale, dir: localeDirection(locale), start_url: `/${locale}/app/field`, scope: "/", display: "standalone",
    background_color: "#F5F6F2", theme_color: "#0B6B5F",
    icons: [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] };
}
