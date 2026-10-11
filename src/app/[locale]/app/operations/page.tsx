import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { listOperationTasks } from "@/modules/reservations/application/reservation-service";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function OperationsPage({
  params
}: Readonly<{
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const [t, tasks] = await Promise.all([getTranslations("Operations"), listOperationTasks(ctx)]);

  return (
    <section className="resource-page" data-testid="operations-page">
      <header className="resource-header">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <div className="app-actions">
          <Link className="secondary-button" href={`/${appLocale}/app/reservations`}>
            {t("newReservation")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("backToWorkspace")}
          </Link>
        </div>
      </header>

      <section className="workspace-main">
        <div className="section-heading">
          <p className="panel-label">{t("listLabel")}</p>
          <span data-testid="operation-task-count">{t("count", { count: tasks.length })}</span>
        </div>
        {tasks.length === 0 ? (
          <p className="empty-state" data-testid="operation-tasks-empty">
            {t("empty")}
          </p>
        ) : (
          <div className="resource-list">
            {tasks.map((task) => (
              <div className="resource-row task-row" data-testid="operation-task-row" key={task.id}>
                <span>
                  <strong data-testid="operation-task-title">
                    {localizedTaskTitle(task.title, appLocale)}
                  </strong>
                  <small>
                    {t("rowMeta", {
                      property: task.propertyName,
                      reservation: task.reservationReference ?? t("noReservation")
                    })}
                  </small>
                </span>
                <span>
                  {t("dueDate", {
                    dueDate: task.dueDate
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
