import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitch } from "@/i18n/locale-switch";
import type { AppLocale } from "@/i18n/routing";
import styles from "./website.module.css";

export async function WebsiteLanguageNav({ locale, path = "" }: { locale: AppLocale; path?: string }) {
  const t = await getTranslations({ locale, namespace: "Website" });
  return <LocaleSwitch currentLocale={locale} path={path} label={t("language")}
    displayNames={{ en: t("languages.en"), fr: t("languages.fr"), ar: t("languages.ar") }} />;
}

export function WebsitePageTitle({ locale, title, description, path = "" }: {
  locale: AppLocale;
  title: string;
  description: string;
  path?: string;
}) {
  return (
    <div className={styles.sectionIntro}>
      <WebsiteLanguageNav locale={locale} path={path} />
      <h1>{title}</h1>
      <p className={styles.lede}>{description}</p>
    </div>
  );
}

export async function WebsiteAssessmentLink({ locale }: { locale: AppLocale }) {
  const t = await getTranslations({ locale, namespace: "Website" });
  return <Link className="primary-button" href={`/${locale}/assessment`} prefetch={false}>{t("assessment")}</Link>;
}

export function WebsiteList({ items, ordered = false, className, heading: Heading = "h3" }: {
  items: readonly { key: string; title: string; description: string }[];
  ordered?: boolean;
  className?: string;
  heading?: "h2" | "h3";
}) {
  const List = ordered ? "ol" : "ul";
  return (
    <List className={className}>
      {items.map(item => (
        <li key={item.key}>
          <Heading>{item.title}</Heading>
          <p>{item.description}</p>
        </li>
      ))}
    </List>
  );
}
