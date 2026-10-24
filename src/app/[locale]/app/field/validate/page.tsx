import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { FieldShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { authorizeCollection } from "@/platform/authz/authorize";
import { FieldLanguage } from "@/platform/offline/field-language";
import { fieldProxyTasks } from "@/modules/reservations/application/field-proxy-service";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { taskText } from "@/modules/reservations/domain/operation-task";

export const dynamic = "force-dynamic";
export default async function ProxyTasksPage({ params, searchParams }: {
  params: Promise<{ locale: string }>; searchParams: Promise<{ page?: string; search?: string }>;
}) {
  const locale = safeLocale((await params).locale); setRequestLocale(locale);
  const session = await auth(); if (session?.user?.id && session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const ctx = await reservationActorContextFromSession(session); if (!ctx) redirect(`/${locale}/login?surface=field`);
  if (!authorizeCollection(ctx.authContext, "view", "task") || !authorizeCollection(ctx.authContext, "validate", "task")) notFound();
  const query = await searchParams, page = Number(query.page ?? "1"), search = typeof query.search === "string" ? query.search.trim() : "";
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || search.length > 120) notFound();
  const [t, format, data] = await Promise.all([getTranslations("FieldProxy"), getFormatter(), fieldProxyTasks(ctx, { page, search })]);
  const pageUrl = (next: number) => `/${locale}/app/field/validate?${new URLSearchParams({ page: String(next), search })}`;
  return <FieldShell className="field-page" testId="field-proxy-list"><ShellHeader title={t("title")} eyebrow={t("eyebrow")} subtitle={t("help")}
    actions={<Link className="secondary-button" href={`/${locale}/app/field`}>{t("back")}</Link>} />
    <FieldLanguage locale={locale} path="/app/field/validate" />
    <form method="get" className="team-search"><label htmlFor="field-proxy-search">{t("searchVilla")}</label>
      <input id="field-proxy-search" name="search" type="search" maxLength={120} defaultValue={search} data-testid="field-proxy-search" />
      <button className="secondary-button" type="submit">{t("search")}</button></form>
    {data.tasks.length ? <ul className="field-job-list">{data.tasks.map(task => <li key={task.id}>
      <Link className="field-task-card" data-testid="field-proxy-card" href={`/${locale}/app/field/validate/${task.id}`}>
        <strong>{task.propertyName}</strong><span>{localizedText(taskText(task.title), locale)}</span>
        <span>{format.dateTime(task.dueDate, { dateStyle: "medium", timeZone: "UTC" })}</span></Link></li>)}</ul> : <p data-testid="field-proxy-empty">{t("empty")}</p>}
    <nav className="form-actions" aria-label={t("pages")}>
      {page > 1 ? <Link className="secondary-button" href={pageUrl(page - 1)}>{t("previous")}</Link> : null}
      {page * data.size < data.count ? <Link className="secondary-button" href={pageUrl(page + 1)}>{t("next")}</Link> : null}
    </nav></FieldShell>;
}
