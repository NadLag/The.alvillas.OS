import { setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { WebsiteDetail } from "../website-detail";
import { websiteMetadata } from "../website-metadata";

export const generateMetadata = websiteMetadata("/management");

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  return <WebsiteDetail locale={locale} subject="management" />;
}
