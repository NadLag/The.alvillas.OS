import type { ReactNode } from "react";
import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { safeLocale } from "@/i18n/routing";
import { personalNavigation } from "@/modules/personal/application/personal-session";
import styles from "@/modules/personal/ui/personal.module.css";
import { LogoutForm } from "@/platform/offline/logout-form";
import { logoutAction } from "@/modules/identity/application/session-actions";

export default async function HouseholdLayout({ children, params }: {
  children: ReactNode; params: Promise<{ locale: string; householdId: string }>;
}) {
  const { locale: rawLocale, householdId } = await params;
  const locale = safeLocale(rawLocale);
  setRequestLocale(locale);
  const [t, household] = await Promise.all([getTranslations({ locale, namespace: "Personal" }), personalNavigation(locale, householdId)]);
  const path = `/personal/${householdId}`;
  return <AdminShell className={`resource-page ${styles.workspace}`}>
    <ShellHeader eyebrow={t("title")} title={household.name} actions={<>
      <LocaleSwitch currentLocale={locale} label={t("language")} path={path} />
      <LogoutForm action={logoutAction.bind(null, locale)} label={t("signOut")} />
    </>} />
    <nav className="form-actions" aria-label={t("navigation")}>
      <Link className="secondary-button" prefetch={false} href={`/${locale}${path}`}>{t("dashboard")}</Link>
      {household.areas.map((area) => (
        <Link className="secondary-button" key={area} prefetch={false} href={`/${locale}${path}/${area}`}>{t(`sections.${area}`)}</Link>
      ))}
      <Link className="secondary-button" prefetch={false} href={`/${locale}/personal`}>{t("households")}</Link>
    </nav>
    {children}
  </AdminShell>;
}
