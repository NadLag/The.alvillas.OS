import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function HomePage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Home");

  return (
    <section className="home">
      <div className="status-row" aria-label={t("statusLabel")}>
        <span className="status-chip">{t("phase")}</span>
        <span className="status-chip">{t("tenant")}</span>
        <span className="status-chip">{t("i18n")}</span>
      </div>
      <h1>{t("title")}</h1>
      <p>{t("subtitle")}</p>
    </section>
  );
}
