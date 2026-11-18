import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { AdminShell, EmptyState, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { formatDate } from "@/i18n/format";
import { auth } from "@/platform/auth/session";
import { authorizeCollection } from "@/platform/authz/authorize";
import { maskedValue } from "@/platform/authz/present";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationManagement } from "@/modules/reservations/application/operation-management";
import { operationReadiness } from "@/modules/reservations/application/operation-automation";
import { commandTaskTitle } from "@/modules/reservations/application/command-center-today";
import { localizedTextSchema } from "@/i18n/content";

const tabs = ["workload", "readiness", "delays"] as const;
const filters = z.object({ view: z.enum(tabs).default("workload"), propertyId: z.uuid().optional(), from: z.iso.date().optional(),
  until: z.iso.date().optional(), page: z.coerce.number().int().positive().default(1) })
  .refine(value => !value.from || !value.until || value.from <= value.until);

export default async function CommandOperationsPage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const [session, raw, t, shell, ops] = await Promise.all([
    auth(), searchParams, getTranslations("CommandOperations"), getTranslations("AppShell"), getTranslations("Operations.manage")
  ]);
  if (!session?.user.id) redirect(`/${locale}/login`);
  if (session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const actor = await reservationActorContextFromSession(session);
  if (!actor || !authorizeCollection(actor.authContext, "view", "task")) notFound();
  const filter = filters.safeParse(Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== "")));
  const base = `/${locale}/app`, route = base + "/command-center/operations";
  const view = filter.success ? filter.data.view : "workload";
  const selection = filter.success ? filter.data : null;
  const management = selection && view !== "readiness"
    ? await operationManagement(actor, { view: "LIST", from: selection.from, until: selection.until, propertyId: selection.propertyId,
      state: view === "delays" ? "OVERDUE" : undefined, page: view === "delays" ? selection.page : 1 }, { includeWorkload: view === "workload" })
    : null;
  const properties = selection && view === "readiness" ? await operationReadiness(actor) : [];
  const readiness = properties.filter(property => !selection?.propertyId || selection.propertyId === property.propertyId);
  const workload = management?.workload;
  const count = view === "readiness" ? readiness.length : view === "workload" ? workload?.workers.length ?? 0 : management?.count ?? 0;
  const size = view === "delays" ? management?.size ?? 50 : 25;
  const last = Math.max(1, Math.ceil(count / size));
  const page = view === "delays" ? selection?.page ?? 1 : Math.min(last, selection?.page ?? 1);
  const start = (page - 1) * size;
  const choices = view === "readiness" ? properties.map(row => ({ id: row.propertyId, name: row.name })) : management?.properties ?? [];
  const href = (page: number) => route + "?" + new URLSearchParams({ view, page: String(page),
    ...(selection?.propertyId ? { propertyId: selection.propertyId } : {}),
    ...(selection?.from ? { from: selection.from } : {}), ...(selection?.until ? { until: selection.until } : {}) }).toString();
  return <AdminShell className="resource-page" testId="command-center-operations">
    <ShellHeader title={t("title")} eyebrow={shell("eyebrow")} actions={<Link className="secondary-button" href={base}>{t("back")}</Link>} />
    <nav className="form-actions" aria-label={t("title")}>{tabs.map(tab =>
      <Link key={tab} href={route + "?view=" + tab} className="secondary-button" aria-current={tab === view ? "page" : undefined}>{t(tab)}</Link>
    )}</nav>
    {selection ? <>
      <form className="statement-filters">
        <input type="hidden" name="view" value={view} />
        <label className="field"><span>{t("property")}</span><select name="propertyId" defaultValue={selection.propertyId ?? ""}>
          <option value="">{t("allProperties")}</option>
          {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
        </select></label>
        {view !== "readiness" ? <>
          <label className="field"><span>{t("from")}</span><input type="date" name="from" defaultValue={selection.from} /></label>
          <label className="field"><span>{t("until")}</span><input type="date" name="until" defaultValue={selection.until} /></label>
        </> : null}
        <button type="submit" className="secondary-button">{t("apply")}</button>
      </form>
      <section className="detail-panel">
        <h2>{t(view)}</h2>
        {view === "workload" && workload ? <ul className="resource-list">
          <li className="resource-row"><strong>{t("unassigned")}</strong><span>{t("open", { count: workload.unassigned })}</span></li>
          {workload.workers.slice(start, start + size).map(worker => <li className="resource-row" key={worker.id}>
            <strong>{worker.name === maskedValue ? t("privateWorker") : worker.name}</strong><span>{t("open", { count: worker.open })}</span>
          </li>)}
        </ul> : null}
        {view === "readiness" ? <ul className="resource-list">{readiness.slice(start, start + size).map(row =>
          <li className="resource-row" key={row.propertyId}>
            <Link href={base + "/operations?propertyId=" + row.propertyId}>{row.name}</Link>
            <span>{ops("readiness." + row.readiness)}</span><span>{t("readinessCounts", { delayed: row.overdue, atRisk: row.atRisk })}</span>
          </li>)}</ul> : null}
        {view === "delays" ? <ul className="resource-list">{management?.tasks.map(task => {
          const title = localizedTextSchema.safeParse(task.titleTranslations);
          return <li className="resource-row" key={task.id}>
            <Link href={base + "/operations/" + task.id}>{commandTaskTitle(title.success ? title.data : null, locale, t("job"))}</Link>
            <span>{task.property.name}</span><span>{formatDate(locale, task.dueDate, { timeZone: "UTC" })}</span>
          </li>;
        })}</ul> : null}
        {!count && !workload?.unassigned ? <EmptyState>{t("empty")}</EmptyState> : null}
        {last > 1 ? <nav className="form-actions" aria-label={t(view)}>
          {page > 1 ? <Link href={href(Math.min(last, page - 1))} className="secondary-button">{t("previous")}</Link> : null}
          {page < last ? <Link href={href(page + 1)} className="secondary-button">{t("next")}</Link> : null}
        </nav> : null}
      </section>
    </> : <EmptyState>{t("invalid")} <Link href={route}>{t("reset")}</Link></EmptyState>}
  </AdminShell>;
}
