import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { safeLocale, type AppLocale } from "@/i18n/routing";
import { publicLanguageUrls, publicWebsiteOrigin, type PublicWebsitePath } from "@/platform/website/site";

const openGraphLocales = { en: "en_US", fr: "fr_MA", ar: "ar_MA" } satisfies Record<AppLocale, string>;

export function websiteMetadata(path: PublicWebsitePath) {
  return async ({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> => {
    const locale = safeLocale((await params).locale);
    const t = await getTranslations({ locale, namespace: "Website" });
    const subject = path === "" || path === "/assessment" ? null : path.slice(1) as "management" | "services" | "about";
    const title = path === "" ? t("hero.title") : path === "/assessment" ? t("assessment") : t(`pages.${subject!}.title`);
    const description = path === "" ? t("hero.description") : path === "/assessment" ? t("assessmentForm.intro") : t(`pages.${subject!}.description`);
    const languages = publicLanguageUrls(path);
    return {
      metadataBase: new URL(publicWebsiteOrigin),
      title: `${title} | ALVILLAS`,
      description,
      alternates: { canonical: languages[locale], languages: { ...languages, "x-default": languages.en } },
      openGraph: {
        title, description, url: languages[locale], siteName: "ALVILLAS",
        type: "website", locale: openGraphLocales[locale],
        alternateLocale: Object.entries(openGraphLocales).filter(([language]) => language !== locale).map(([, code]) => code),
        images: [{ url: "/website-card", width: 1200, height: 630, alt: "ALVILLAS" }]
      },
      twitter: { card: "summary_large_image", title, description, images: ["/website-card"] }
    };
  };
}
