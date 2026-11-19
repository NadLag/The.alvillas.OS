import { getTranslations } from "next-intl/server";
import type { AppLocale } from "@/i18n/routing";
import { WebsiteAssessmentLink, WebsiteList, WebsitePageTitle } from "./website-content";
import styles from "./website.module.css";

const details = {
  management: ["item1", "item2", "item3", "item4"],
  services: ["item1", "item2", "item3", "item4"],
  about: ["item1", "item2", "item3"]
} as const;

export type WebsiteSubject = keyof typeof details;

export async function WebsiteDetail({ locale, subject }: { locale: AppLocale; subject: WebsiteSubject }) {
  const t = await getTranslations({ locale, namespace: "Website" });
  const path = `/${subject}`;
  return (
    <article className={`${styles.frame} ${styles.section}`}>
      <WebsitePageTitle locale={locale} title={t(`pages.${subject}.title`)}
        description={t(`pages.${subject}.description`)} path={path} />
      <WebsiteList className={styles.detailList} heading="h2" items={details[subject].map(key => ({
        key, title: t(`pages.${subject}.items.${key}.title`), description: t(`pages.${subject}.items.${key}.description`)
      }))} />
      <WebsiteAssessmentLink locale={locale} />
    </article>
  );
}
