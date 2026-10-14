import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { routing, safeLocale } from "@/i18n/routing";
import { LoginForm } from "@/modules/identity/ui/login-form";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LoginPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();

  if (session?.user?.id) {
    redirect(`/${safeLocale(session.user.preferredLocale)}/app`);
  }

  const t = await getTranslations("Login");

  return (
    <section className="auth-page">
      <div className="auth-topbar">
        <Link className="secondary-button" href={`/${appLocale}`}>
          {t("publicSite")}
        </Link>
        <LocaleSwitch currentLocale={appLocale} label={t("language")} path="/login" />
      </div>
      <div className="auth-panel">
        <div className="auth-panel-header">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <LoginForm
          locale={appLocale}
          labels={{
            email: t("email"),
            phone: t("phone"),
            password: t("password"),
            pin: t("pin"),
            authMethod: t("authMethod"),
            emailPassword: t("emailPassword"),
            phonePin: t("phonePin"),
            fieldWorker: t("fieldWorker"),
            mfaTitle: t("mfaTitle"),
            mfaSubtitle: t("mfaSubtitle"),
            mfaCode: t("mfaCode"),
            recoveryCode: t("recoveryCode"),
            useRecoveryCode: t("useRecoveryCode"),
            useAuthenticatorCode: t("useAuthenticatorCode"),
            recoverAccount: t("recoverAccount"),
            continue: t("continue"),
            verify: t("verify"),
            submit: t("submit"),
            submitting: t("submitting"),
            invalid: t("invalid"),
            mfaInvalid: t("mfaInvalid"),
            rateLimited: t("rateLimited"),
            generic: t("generic")
          }}
        />
      </div>
    </section>
  );
}
