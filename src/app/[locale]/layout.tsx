import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import "../globals.css";
import { localeDirection, routing, type AppLocale } from "@/i18n/routing";

export async function generateMetadata({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>): Promise<Metadata> {
  const { locale } = await params;
  const appLocale = routing.locales.includes(locale as AppLocale)
    ? (locale as AppLocale)
    : routing.defaultLocale;
  const t = await getTranslations({ locale: appLocale, namespace: "Metadata" });

  return {
    title: t("title"),
    description: t("description")
  };
}

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as AppLocale)) {
    notFound();
  }

  const appLocale = locale as AppLocale;
  setRequestLocale(appLocale);
  const messages = await getMessages();

  return (
    <html lang={appLocale} dir={localeDirection(appLocale)}>
      <body>
        <NextIntlClientProvider messages={messages}>
          <main className="shell">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
