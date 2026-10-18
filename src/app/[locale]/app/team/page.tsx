import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader, StatusBadge } from "@/design-system/shells";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { teamActorContextFromSession, teamDirectory } from "@/modules/identity/application/team-service";
import { TeamProfileForm } from "@/modules/identity/ui/team-forms";

export const dynamic = "force-dynamic";
export default async function TeamPage({
  params,
  searchParams
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ search?: string; page?: string }>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const session = await auth();
  if (session?.user?.securitySetupRequired) redirect(`/${locale}/app/security`);
  const ctx = await teamActorContextFromSession(session);
  if (!ctx) redirect(`/${locale}/login`);
  const query = await searchParams;
  const page = /^\d{1,5}$/u.test(query.page ?? "") ? Math.max(1, Number(query.page)) : 1;
  const [t, data] = await Promise.all([
    getTranslations("Team"),
    teamDirectory(ctx, { search: query.search?.slice(0, 120) ?? "", page })
  ]);
  return (
    <AdminShell className="resource-page" testId="team-page">
      <ShellHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Link className="secondary-button" href={`/${locale}/app`}>
            {t("back")}
          </Link>
        }
      />
      <form className="team-search" method="get">
        <label htmlFor="team-search">{t("search")}</label>
        <input id="team-search" name="search" defaultValue={data.search} maxLength={120} />
        <button className="secondary-button">{t("search")}</button>
      </form>
      {data.canCreate ? (
        <details className="team-section">
          <summary>{t("create")}</summary>
          <TeamProfileForm />
        </details>
      ) : null}
      <p>{t("peopleCount", { count: data.total })}</p>
      {data.people.length ? (
        <ul className="team-directory">
          {data.people.map((person) => (
            <li key={person.id}>
              <Link href={`/${locale}/app/team/${person.id}`}>{person.displayName}</Link>
              <StatusBadge>{t(person.archived ? "offboarded" : "active")}</StatusBadge>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState>{t("empty")}</EmptyState>
      )}
      <nav className="app-actions" aria-label={t("pagination")}>
        {data.page > 1 ? (
          <Link
            className="secondary-button"
            href={`?search=${encodeURIComponent(data.search)}&page=${data.page - 1}`}
          >
            {t("previous")}
          </Link>
        ) : null}
        {data.total > data.page * 25 ? (
          <Link
            className="secondary-button"
            href={`?search=${encodeURIComponent(data.search)}&page=${data.page + 1}`}
          >
            {t("next")}
          </Link>
        ) : null}
      </nav>
    </AdminShell>
  );
}
