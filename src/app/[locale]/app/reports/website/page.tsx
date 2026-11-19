import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { localeLabels, safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { prisma } from "@/platform/db/client";
import { listPublicPageViews, utcAnalyticsDate, WebsiteAnalyticsAccessError } from "@/platform/website/analytics-service";

export default async function WebsiteReportPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ day?: string | string[] }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const session = await auth();
  if (!session?.user?.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await accountActorContextFromSession(session);
  if (!actor) notFound();
  const today = utcAnalyticsDate();
  const day = z.iso.date().safeParse((await searchParams).day ?? today);
  if (!day.success || day.data > today) notFound();
  let rows;
  try {
    rows = await listPublicPageViews(actor, day.data, prisma);
  } catch (error) {
    if (error instanceof WebsiteAnalyticsAccessError) notFound();
    throw error;
  }
  const [t, reports] = await Promise.all([getTranslations("WebsiteAnalytics"), getTranslations("ReportsWorkspace")]);
  const count = new Intl.NumberFormat(locale);

  return (
    <AdminShell className="resource-page">
      <ShellHeader eyebrow={reports("title")} title={t("title")} subtitle={t("description")}
        actions={<Link className="secondary-button" href={`/${locale}/app/reports`}>{reports("back")}</Link>} />
      <form className="form-actions">
        <label className="field"><span>{t("date")}</span><input name="day" type="date" defaultValue={day.data} max={today} required /></label>
        <button className="primary-button" type="submit">{t("apply")}</button>
      </form>
      {rows.length ? <ul className="resource-list">
        {rows.map(row => <li className="resource-row" key={row.locale + row.path}>
          <bdi>{"/" + row.locale + row.path}</bdi>
          <span>{localeLabels[row.locale]}</span>
          <span>{t("count", { count: count.format(row.pageViews) })}</span>
        </li>)}
      </ul> : <p role="status">{t("noData")}</p>}
    </AdminShell>
  );
}
