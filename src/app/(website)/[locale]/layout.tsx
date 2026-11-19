import Image from "next/image";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import styles from "./website.module.css";
import { notFound } from "next/navigation";
import { appLocales, localeDirection } from "@/i18n/routing";
import { publicWebsiteBrand } from "@/platform/website/site";
import { publicAnalyticsEnabled } from "@/platform/website/website-environment";
import { PageViewCounter } from "./page-view-counter";
import "../../globals.css";

export function generateStaticParams() {
  return appLocales.map(locale => ({ locale }));
}

export default async function WebsiteLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: requestedLocale } = await params;
  const locale = appLocales.find(language => language === requestedLocale);
  if (!locale) notFound();
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Website" });
  const home = `/${locale}`;

  return (
    <html lang={locale} dir={localeDirection(locale)}>
      <body className={styles.site}>
        <header className={styles.header}>
          <div className={styles.frame}>
            <Link className={styles.brand} href={home} lang="en">
              <Image src="/app-icon.svg" width={36} height={36} alt="" />
              {publicWebsiteBrand}
            </Link>
            <nav aria-label={t("navigation")} className={styles.navigation}>
              <Link href={`${home}/management`}>{t("management")}</Link>
              <Link href={`${home}/services`}>{t("services")}</Link>
              <Link href={`${home}/about`}>{t("about")}</Link>
              <Link className={styles.assessmentNav} href={`${home}/assessment`} prefetch={false}>{t("assessment")}</Link>
            </nav>
            <a className={styles.signIn} data-testid="home-sign-in" href={`${home}/login`}>
              <span data-testid="home-sign-in-nav">{t("signIn")}</span>
            </a>
          </div>
        </header>
        <main>{children}</main>
        {publicAnalyticsEnabled() && <PageViewCounter locale={locale} />}
        <footer className={styles.footer}>
          <div className={styles.frame}>
            <Link className={styles.brand} href={home} lang="en">{publicWebsiteBrand}</Link>
            <p>{t("location")}</p>
            <Link href={`${home}/assessment`} prefetch={false}>{t("assessment")}</Link>
          </div>
        </footer>
      </body>
    </html>
  );
}
