import { getTranslations } from "next-intl/server";
import { routing, type AppLocale } from "@/i18n/routing";
import { fieldManifest } from "@/platform/offline/field-manifest";

export async function GET(_request: Request, { params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as AppLocale)) return new Response(null, { status: 404 });
  const t = await getTranslations({ locale, namespace: "Metadata" });
  return Response.json(fieldManifest(locale as AppLocale, { title: t("title"), description: t("description") }), {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" }
  });
}
