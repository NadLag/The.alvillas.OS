import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { WebsiteAssessmentLink, WebsiteLanguageNav, WebsiteList } from "./website-content";
import styles from "./website.module.css";
import { publicWebsiteOrigin } from "@/platform/website/site";
import { websiteMetadata } from "./website-metadata";

export const generateMetadata = websiteMetadata("");

const pillars = ["management", "operations", "guestExperience", "ownerControl"] as const;
const steps = ["assessment", "agreement", "onboarding", "management"] as const;

export default async function Homepage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Website" });

  const business = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "ALVILLAS",
    url: publicWebsiteOrigin,
    logo: publicWebsiteOrigin + "/app-icon.svg",
    areaServed: { "@type": "City", name: "Marrakech", containedInPlace: { "@type": "Country", name: "Morocco" } }
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(business).replaceAll("<", "\\u003c") }} />
      <section className={styles.hero} aria-labelledby="homepage-title">
        <div className={`${styles.frame} ${styles.heroFrame}`}>
          <div className={styles.heroCopy}>
            <WebsiteLanguageNav locale={locale} />
            <p className={styles.eyebrow}>{t("location")}</p>
            <h1 id="homepage-title">{t("hero.title")}</h1>
            <p className={styles.lede}>{t("hero.description")}</p>
            <WebsiteAssessmentLink locale={locale} />
          </div>
          <div className={styles.relief} aria-hidden="true"><span /><span /><span /></div>
        </div>
      </section>
      <section className={`${styles.frame} ${styles.section}`} aria-labelledby="pillars-title">
        <div className={styles.sectionIntro}>
          <h2 id="pillars-title">{t("pillars.title")}</h2>
          <p>{t("pillars.description")}</p>
        </div>
        <WebsiteList className={styles.pillars} items={pillars.map(key => ({
          key, title: t(`pillars.${key}.title`), description: t(`pillars.${key}.description`)
        }))} />
      </section>
      <section className={styles.process} aria-labelledby="process-title">
        <div className={`${styles.frame} ${styles.section} ${styles.split}`}>
          <div className={styles.sectionIntro}>
            <h2 id="process-title">{t("process.title")}</h2>
            <p>{t("process.description")}</p>
          </div>
          <WebsiteList ordered className={styles.steps} items={steps.map(key => ({
            key, title: t(`process.${key}.title`), description: t(`process.${key}.description`)
          }))} />
        </div>
      </section>
      <div className={`${styles.frame} ${styles.section} ${styles.split}`}>
        <section className={styles.sectionIntro} aria-labelledby="guest-services-title">
          <h2 id="guest-services-title">{t("guestServices.title")}</h2>
          <p>{t("guestServices.description")}</p>
          <Link className={styles.textLink} href={`/${locale}/services`}>{t("guestServices.link")}</Link>
        </section>
        <section className={styles.sectionIntro} aria-labelledby="why-title">
          <h2 id="why-title">{t("why.title")}</h2>
          <p>{t("why.description")}</p>
          <Link className={styles.textLink} href={`/${locale}/about`}>{t("why.link")}</Link>
        </section>
      </div>
      <section className={styles.location} aria-labelledby="locations-title">
        <div className={`${styles.frame} ${styles.section} ${styles.split}`}>
          <h2 id="locations-title">{t("coverage.title")}</h2>
          <div className={styles.sectionIntro}>
            <h3>{t("location")}</h3>
            <p>{t("coverage.description")}</p>
          </div>
        </div>
      </section>
      <section className={`${styles.frame} ${styles.section} ${styles.callout}`} aria-labelledby="assessment-title">
        <h2 id="assessment-title">{t("assessmentPrompt.title")}</h2>
        <p>{t("assessmentPrompt.description")}</p>
        <WebsiteAssessmentLink locale={locale} />
      </section>
    </>
  );
}
