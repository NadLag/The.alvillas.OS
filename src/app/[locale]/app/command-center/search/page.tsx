import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { commandSearchKinds, CommandSearchChangedError, searchCommandCenter, searchFilters } from "@/platform/command-center/search";

export default async function CommandSearchPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [session, raw, t, shell] = await Promise.all([auth(), searchParams, getTranslations("CommandSearch"), getTranslations("AppShell")]);
  if (!session?.user.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await accountActorContextFromSession(session);
  if (!actor) notFound();
  const kinds = commandSearchKinds(actor.authContext);
  if (!kinds.length) notFound();
  const base = `/${locale}/app`, route = base + "/command-center/search";
  const filter = searchFilters.safeParse({ ...raw, kind: raw.kind === "" ? undefined : raw.kind });
  const result = filter.success ? await searchCommandCenter(actor, filter.data, locale).catch((error: unknown) => {
    if (error instanceof CommandSearchChangedError) return null;
    throw error;
  }) : [];
  const q = typeof raw.q === "string" ? raw.q : "";
  const groups = result?.filter(group => group.items.length) ?? [];
  const href = (kind: string, after?: string) => route + "?" + new URLSearchParams({ q, kind, ...(after ? { after } : {}) }).toString();
  return <AdminShell className="resource-page" testId="command-center-search">
    <ShellHeader title={t("title")} eyebrow={shell("eyebrow")} actions={<Link href={base} className="secondary-button">{t("back")}</Link>} />
    <form className="statement-filters" role="search">
      <label className="field"><span>{t("query")}</span><input type="search" name="q" defaultValue={q} minLength={2} maxLength={120} required /></label>
      <label className="field"><span>{t("resource")}</span><select name="kind" defaultValue={filter.data?.kind ?? ""}>
        <option value="">{t("all")}</option>
        {kinds.map(kind => <option value={kind} key={kind}>{t("kind." + kind)}</option>)}
      </select></label>
      <button type="submit" className="primary-button">{t("title")}</button>
    </form>
    {result === null ? <EmptyState>{t("changed")} <Link href={route}>{t("reset")}</Link></EmptyState> : null}
    {result !== null && filter.success && !groups.length ? <EmptyState>{t("empty")}</EmptyState> : null}
    {!filter.success && q.length ? <EmptyState>{t("invalid")}</EmptyState> : null}
    {groups.map(group => <section className="detail-panel" key={group.kind}>
      <h2>{t("kind." + group.kind)}</h2>
      <ul className="resource-list">{group.items.map(item => <li className="resource-row" key={item.id}><Link href={base + item.href}>{item.title}</Link></li>)}</ul>
      {group.next ? <Link className="secondary-button" href={href(group.kind, filter.data?.kind ? group.next : undefined)}>
        {t(filter.data?.kind ? "next" : "allIn", { kind: t("kind." + group.kind) })}
      </Link> : null}
    </section>)}
  </AdminShell>;
}
