import { getTranslations, setRequestLocale } from "next-intl/server";
import { ActivationForm } from "@/modules/identity/ui/activation-form";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function ActivationPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ locale: string; code: string }>;
  searchParams: Promise<{ surface?: string }>;
}>) {
  const { locale, code } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);
  const portal = (await searchParams).surface === "owner";
  const t = await getTranslations("Identity.activation");

  return (
    <section className="auth-page">
      <div className="auth-panel">
        <p className="eyebrow">{t("eyebrow")}</p>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
        <ActivationForm
          code={code}
          passwordRequired={portal}
          labels={{
            phone: t("phone"),
            pin: t("pin"),
            password: t(portal ? "portalPassword" : "password"),
            activate: t("activate"),
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
