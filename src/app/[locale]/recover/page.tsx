import { getTranslations, setRequestLocale } from "next-intl/server";
import { PasswordRecoveryForm } from "@/modules/identity/ui/activation-form";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function RecoveryPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);
  const t = await getTranslations("Identity.recovery");

  return (
    <section className="auth-page">
      <div className="auth-panel">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
        <PasswordRecoveryForm
          labels={{
            email: t("email"),
            recoveryCode: t("recoveryCode"),
            newPassword: t("newPassword"),
            recover: t("recover"),
            validation: t("validation"),
            conflict: t("conflict"),
            generic: t("generic")
          }}
          locale={appLocale}
        />
      </div>
    </section>
  );
}
