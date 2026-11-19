import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { EmptyState } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { personalNavigation } from "@/modules/personal/application/personal-session";

export default async function PersonalDashboard({ params }: { params: Promise<{ locale: string; householdId: string }> }) {
  const { locale: rawLocale, householdId } = await params;
  const locale = safeLocale(rawLocale);
  const [t, navigation] = await Promise.all([getTranslations({ locale, namespace: "Personal" }), personalNavigation(locale, householdId)]);
  const cards = (["income", "expenses", "budgets", "savings", "investments", "positions", "documents", "reports", "transfers"] as const)
    .filter((area) => navigation.areas.includes(area));
  return <section className="detail-panel">
    <h2>{t("dashboard")}</h2>
    {cards.length ? <ul className="form-actions">
      {cards.map((area) => <li key={area}><Link className="secondary-button" prefetch={false} href={`/${locale}/personal/${householdId}/${area}`}>{t(`sections.${area}`)}</Link></li>)}
    </ul> : <EmptyState>{t("noGrants")}</EmptyState>}
  </section>;
}
