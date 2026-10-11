import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "../../../../auth";
import { routing, type AppLocale } from "@/i18n/routing";
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
  const appLocale = routing.locales.includes(locale as AppLocale)
    ? (locale as AppLocale)
    : routing.defaultLocale;
  setRequestLocale(appLocale);

  const session = await auth();

  if (session) {
    redirect(`/${appLocale}/app`);
  }

  const t = await getTranslations("Login");
  const switchLocale = appLocale === "fr" ? "en" : "fr";

  return (
    <section className="auth-page">
      <div className="locale-switch" aria-label={t("language")}>
        <Link href={`/${switchLocale}/login`}>{t(`switch.${switchLocale}`)}</Link>
      </div>
      <div className="auth-panel">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
        <LoginForm
          locale={appLocale}
          labels={{
            email: t("email"),
            password: t("password"),
            submit: t("submit"),
            invalid: t("invalid"),
            rateLimited: t("rateLimited"),
            generic: t("generic")
          }}
        />
      </div>
    </section>
  );
}
