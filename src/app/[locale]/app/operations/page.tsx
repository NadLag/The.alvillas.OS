import { randomUUID } from "node:crypto";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { ManagerShell, ShellHeader, EmptyState } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { authorizeCollection } from "@/platform/authz/authorize";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationManagement } from "@/modules/reservations/application/operation-management";
import { operationReadiness } from "@/modules/reservations/application/operation-automation";
import {
  taskPriorities,
  taskStates,
  taskText,
  taskViewModes,
} from "@/modules/reservations/domain/operation-task";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { OperationForm } from "@/modules/reservations/ui/operation-form";
import { whatsappComposerPath } from "@/platform/notifications/whatsapp-path";
export const dynamic = "force-dynamic";
export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = safeLocale((await params).locale);
  setRequestLocale(locale);
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx) redirect(`/${locale}/login`);
  const input = Object.fromEntries(
    Object.entries(await searchParams).filter(([, v]) => typeof v === "string"),
  );
  const [t, f, m, readiness, whatsapp] = await Promise.all([
      getTranslations({ locale, namespace: "Operations" }),
      getFormatter({ locale }),
      operationManagement(ctx, input),
      operationReadiness(ctx),
      getTranslations({locale,namespace:"Whatsapp"}),
    ]),
    q = m.query,
    base = `/${locale}/app/operations`;
  const href = (change: Record<string, string | number | undefined> = {}) =>
    `${base}?${new URLSearchParams(
      Object.entries({ ...q, ...change })
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => [k, String(v)]),
    )}`;
  const title = (task: (typeof m.tasks)[number]) =>
      localizedText(taskText(task.titleTranslations), locale),
    canAssign = authorizeCollection(ctx.authContext, "assign", "task"),
    canCreate = authorizeCollection(ctx.authContext, "create", "task");
  const dates: string[] = [];
  if (m.range.from && m.range.until)
    for (
      let n = new Date(m.range.from + "T00:00:00Z").getTime();
      n <= new Date(m.range.until + "T00:00:00Z").getTime();
      n += 86400000
    )
      dates.push(new Date(n).toISOString().slice(0, 10));
  const select = (
    name: string,
    label: string,
    options: Array<{ value: string; label: string }>,
    value?: string,
  ) => (
    <label key={name}>
      {label}
      <select name={name} defaultValue={value ?? ""}>
        <option value="">{t("manage.all")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const date = (name: string, label: string, value?: string) => (
    <label key={name}>
      {label}
      <input type="date" name={name} defaultValue={value} />
    </label>
  );
  const cards = (tasks: typeof m.tasks) =>
    tasks.map((task) => (
      <article
        className="resource-row"
        data-testid="operation-task-row"
        key={task.id}
      >
        <strong data-testid="operation-task-title">
          <Link href={`${base}/${task.id}`}>{title(task)}</Link>
        </strong>
        <small>
          {task.property.name} ·{" "}
          {f.dateTime(task.dueDate, { dateStyle: "medium", timeZone: "UTC" })}
        </small>
        <span>
          {t(`manage.states.${task.risk === "CLEAR" ? task.state : task.risk}`)}
        </span>
        <span>{t(`manage.priorities.${task.priority}`)}</span>
        <Link className="secondary-button" data-testid="task-whatsapp" href={whatsappComposerPath(locale,{type:"task",id:task.id})}>{whatsapp("title")}</Link>
        <span>
          {t("manage.progress", {
            done: task.checklistItems.filter((i) => i.completedAt).length,
            total: task.checklistItems.length,
          })}
        </span>
      </article>
    ));
  return (
    <ManagerShell
      className="resource-page operations-page"
      testId="operations-page"
    >
      <ShellHeader
        title={t("title")}
        subtitle={t("subtitle")}
        eyebrow={t("eyebrow")}
        actions={
          <>
            {canCreate ? (
              <Link className="primary-button" href={`${base}/new`}>
                {t("manage.newTask")}
              </Link>
            ) : null}
            <Link
              className="secondary-button"
              href={`/${locale}/app/reservations`}
            >
              {t("newReservation")}
            </Link>
            <Link className="secondary-button" href={`/${locale}/app`}>
              {t("backToWorkspace")}
            </Link>
          </>
        }
      />
      <section className="workspace-main">
        <nav className="operations-tabs" aria-label={t("manage.viewsLabel")}>
          {taskViewModes.map((view) => (
            <Link
              className="secondary-button"
              aria-current={q.view === view ? "page" : undefined}
              key={view}
              href={href({ view, page: 1 })}
            >
              {t(`manage.views.${view}`)}
            </Link>
          ))}
        </nav>
        <form className="operation-filters" method="get">
          <input type="hidden" name="view" value={q.view} />
          {select(
            "propertyId",
            t("manage.property"),
            m.properties.map((p) => ({ value: p.id, label: p.name })),
            q.propertyId,
          )}
          {select(
            "workerId",
            t("manage.worker"),
            m.workers.map((w) => ({ value: w.id, label: w.name })),
            q.workerId,
          )}
          <label>
            {t("manage.role")}
            <input name="role" defaultValue={q.role ?? ""} />
          </label>
          {select(
            "state",
            t("manage.state"),
            [...taskStates, "OVERDUE", "AT_RISK"].map((s) => ({
              value: s,
              label: t(`manage.states.${s}`),
            })),
            q.state,
          )}
          {select(
            "priority",
            t("manage.priority"),
            taskPriorities.map((p) => ({
              value: p,
              label: t(`manage.priorities.${p}`),
            })),
            q.priority,
          )}
          {select(
            "type",
            t("manage.type"),
            taskTypeSchema.options.map((type) => ({
              value: type,
              label: t(`manage.types.${type}`),
            })),
            q.type,
          )}
          {date("date", t("manage.date"), q.date)}
          {date("from", t("manage.from"), q.from)}
          {date("until", t("manage.until"), q.until)}
          <button className="secondary-button" type="submit">
            {t("manage.filter")}
          </button>
          <Link href={base}>{t("manage.clear")}</Link>
        </form>
        <details className="panel">
          <summary>{t("manage.savedViews")}</summary>
          {m.views.map((view) => (
            <div key={view.id}>
              <Link
                href={`${base}?${new URLSearchParams(Object.entries(view.filters as Record<string, string>).map(([k, v]) => [k, String(v)]))}`}
              >
                {view.name}
              </Link>
              <OperationForm
                locale={locale}
                operation="archive_view"
                idempotencyKey={randomUUID()}
                submit={t("manage.removeView")}
              >
                <input type="hidden" name="id" value={view.id} />
              </OperationForm>
            </div>
          ))}
          <OperationForm
            locale={locale}
            operation="save_view"
            idempotencyKey={randomUUID()}
            submit={t("manage.saveView")}
          >
            <input type="hidden" name="filters" value={JSON.stringify(q)} />
            <label>
              {t("manage.viewName")}
              <input name="name" required maxLength={80} />
            </label>
          </OperationForm>
        </details>
        <div className="section-heading">
          <p className="panel-label">{t("listLabel")}</p>
          <span data-testid="operation-task-count">
            {t("count", { count: m.count })}
          </span>
        </div>
        {m.tasks.length === 0 ? (
          <EmptyState testId="operation-tasks-empty">{t("empty")}</EmptyState>
        ) : q.view === "LIST" ? (
          <OperationForm
            locale={locale}
            operation="bulk"
            idempotencyKey={randomUUID()}
            submit={t("manage.applyBulk")}
          >
            <div className="operation-filters">
              {select(
                "bulkAction",
                t("manage.bulkAction"),
                [
                  "PRIORITY",
                  ...(canAssign ? ["ASSIGN"] : []),
                  "RESCHEDULE",
                  "CANCEL",
                ].map((value) => ({ value, label: t(`manage.bulk.${value}`) })),
                "PRIORITY",
              )}
              {select(
                "priority",
                t("manage.priority"),
                taskPriorities.map((p) => ({
                  value: p,
                  label: t(`manage.priorities.${p}`),
                })),
                "NORMAL",
              )}
              {date("dueDate", t("manage.date"))}
              <label>
                {t("manage.startMinute")}
                <input type="time" name="startTime" />
              </label>
              <label>
                {t("manage.worker")}
                <select name="personId">
                  <option value="">{t("manage.automatic")}</option>
                  {m.crew.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {m.tasks.map((task) => (
              <div key={task.id}>
                <label className="field-checklist-item">
                  <input
                    aria-label={t("manage.selectTask", { title: title(task) })}
                    type="checkbox"
                    disabled={["COMPLETED", "CANCELLED", "SKIPPED"].includes(
                      task.state,
                    )}
                    name="items"
                    value={`${task.id}:${task.version}`}
                  />
                  {t("manage.selectTask", { title: title(task) })}
                </label>
                {cards([task])}
              </div>
            ))}
          </OperationForm>
        ) : q.view === "MONTH" || q.view === "WEEK" ? (
          <div className="operation-calendar" data-testid="operation-calendar">
            {dates.map((day) => (
              <section className="operation-calendar-day" key={day}>
                <h2>
                  <Link href={href({ view: "DAY", date: day, page: 1 })}>
                    {f.dateTime(new Date(day + "T00:00:00Z"), {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </Link>
                </h2>
                {cards(
                  m.tasks.filter(
                    (task) => task.dueDate.toISOString().slice(0, 10) === day,
                  ),
                )}
              </section>
            ))}
          </div>
        ) : (
          <ol className="operation-timeline" data-testid="operation-timeline">
            {m.tasks.map((task) => (
              <li key={task.id}>
                <time>
                  {task.scheduledStart
                    ? f.dateTime(task.scheduledStart, {
                        timeStyle: "short",
                        timeZone: task.property.timezone,
                      })
                    : f.dateTime(task.dueDate, {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      })}
                </time>
                {cards([task])}
              </li>
            ))}
          </ol>
        )}
        <nav className="operations-tabs" aria-label={t("manage.pagination")}>
          {q.page > 1 ? (
            <Link href={href({ page: q.page - 1 })}>
              {t("manage.previous")}
            </Link>
          ) : null}
          <span>{t("manage.page", { page: q.page })}</span>
          {q.page * m.size < m.count ? (
            <Link href={href({ page: q.page + 1 })}>{t("manage.next")}</Link>
          ) : null}
        </nav>
        <details className="panel">
          <summary>{t("manage.readinessTitle")}</summary>
          {readiness
            .filter((r) => !q.propertyId || r.propertyId === q.propertyId)
            .map((r) => (
              <div className="resource-row" key={r.propertyId}>
                <strong>{r.name}</strong>
                {r.generationFailed ? (
                  <p role="alert">{t("manage.generationFailed")}</p>
                ) : null}
                <span>{t(`manage.readiness.${r.readiness}`)}</span>
                <Link
                  href={href({
                    propertyId: r.propertyId,
                    state: "OVERDUE",
                    view: "LIST",
                    page: 1,
                  })}
                >
                  {t("manage.overdueCount", { count: r.overdue })}
                </Link>
                <span>
                  {t("manage.unassignedCount", { count: r.unassigned })}
                </span>
              </div>
            ))}
        </details>
        {canCreate ? (
          <details className="panel">
            <summary>{t("manage.recurringTitle")}</summary>
            <p>
              {t("manage.recurringHelp")}{" "}
              <Link
                href={`/${locale}/app/operations/recurring${q.propertyId ? `?propertyId=${q.propertyId}` : ""}`}
              >
                {t("manage.configureRecurring")}
              </Link>
            </p>
            <OperationForm
              locale={locale}
              operation="recurring"
              idempotencyKey={randomUUID()}
              submit={t("manage.generate")}
            >
              {select(
                "propertyId",
                t("manage.property"),
                m.properties.map((p) => ({ value: p.id, label: p.name })),
                q.propertyId,
              )}
              {date("from", t("manage.from"))}
              {date("until", t("manage.until"))}
            </OperationForm>
          </details>
        ) : null}
      </section>
    </ManagerShell>
  );
}
