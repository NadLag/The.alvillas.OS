import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
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
      <header className="home-nav">
        <span>{t("title")}</span>
        <Link className="secondary-button" data-testid="home-sign-in-nav" href={`/${locale}/login`}>
          {t("signIn")}
        </Link>
      </header>
      <div className="home-hero">
        <div className="status-row" aria-label={t("statusLabel")}>
          <span className="status-chip">{t("phase")}</span>
          <span className="status-chip">{t("tenant")}</span>
          <span className="status-chip">{t("i18n")}</span>
        </div>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
        <div className="home-actions">
          <Link className="primary-button" data-testid="home-sign-in" href={`/${locale}/login`}>
            {t("signIn")}
          </Link>
        </div>
      </div>
    </section>
  );
}
