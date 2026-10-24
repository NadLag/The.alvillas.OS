import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { OfflineFieldApp } from "@/platform/offline/offline-field-app";

export const dynamic = "force-static";
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = safeLocale((await params).locale);
  return { manifest: `/${locale}/manifest.webmanifest`, robots: { index: false, follow: false } };
}
export default async function OfflineFieldPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  return <OfflineFieldApp initialLocale={locale} />;
}
