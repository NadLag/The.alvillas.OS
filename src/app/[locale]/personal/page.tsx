import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { LocaleSwitch } from "@/i18n/locale-switch";
import { safeLocale } from "@/i18n/routing";
import { personalHouseholdIds, personalNavigation, personalSession, requirePersonalSession } from "@/modules/personal/application/personal-session";

export default async function PersonalIndex({ params }: { params: Promise<{ locale: string }> }) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  await requirePersonalSession(locale);
  const ids = await personalHouseholdIds(await personalSession());
  if (!ids.length) notFound();
  if (ids.length === 1) redirect(`/${locale}/personal/${ids[0]}`);
  const [t, households] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }), Promise.all(ids.map(async (id) => ({ id, ...(await personalNavigation(locale, id)) })))
  ]);
  return <AdminShell className="resource-page">
    <ShellHeader eyebrow={t("title")} title={t("households")} actions={<LocaleSwitch currentLocale={locale} label={t("language")} path="/personal" />} />
    <ul className="form-actions">
      {households.map(({ id, name }) => <li key={id}><Link prefetch={false} href={`/${locale}/personal/${id}`} className="secondary-button" dir="auto">{name}</Link></li>)}
    </ul>
  </AdminShell>;
}
