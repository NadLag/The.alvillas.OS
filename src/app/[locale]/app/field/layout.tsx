import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = safeLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return { manifest: `/${locale}/manifest.webmanifest`, appleWebApp: { capable: true, title: t("title"), statusBarStyle: "default" } };
}

export default function FieldLayout({ children }: { children: React.ReactNode }) { return children; }
