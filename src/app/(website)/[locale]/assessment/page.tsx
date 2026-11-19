import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { getWebsiteAssessmentForm } from "@/modules/crm/application/lead-capture-service";
import { prisma } from "@/platform/db/client";
import { WebsitePageTitle } from "../website-content";
import { AssessmentForm } from "./assessment-form";
import styles from "../website.module.css";
import { websiteMetadata } from "../website-metadata";

export const generateMetadata = websiteMetadata("/assessment");

export const dynamic = "force-dynamic";

export default async function AssessmentPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Website" });
  const form = await getWebsiteAssessmentForm(locale, { db: prisma });
  const formLabels = await getTranslations({ locale, namespace: "Website.assessmentForm" });

  return (
    <section className={`${styles.frame} ${styles.section} ${styles.assessment}`}>
      <WebsitePageTitle locale={locale} title={t("assessment")} description={formLabels("intro")} path="/assessment" />
      {form ? <AssessmentForm form={form} labels={Object.fromEntries(assessmentLabelKeys.map(key => [key, formLabels(key)]))}
        /> : <p role="status">{formLabels("unavailable")}</p>}
    </section>
  );
}

const assessmentLabelKeys = [
  "ownerContact", "phone", "email", "location", "propertyTypeKey", "bedrooms", "currentRentalStatusKey",
  "currentOtaKeys", "objectives", "notes", "choice", "source", "acknowledgement", "contactEither", "submit",
  "sending", "accepted", "validation", "rateLimited", "failed", "changed", "reload"
] as const;
