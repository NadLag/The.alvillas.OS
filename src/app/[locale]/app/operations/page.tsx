import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, ManagerShell, ShellHeader } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { listOperationTasks } from "@/modules/reservations/application/reservation-service";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";
import { whatsappComposerPath } from "@/platform/notifications/whatsapp-path";

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
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const [t, tasks] = await Promise.all([getTranslations("Operations"), listOperationTasks(ctx)]);
  const whatsapp = await getTranslations("Whatsapp");

  return (
    <ManagerShell className="resource-page" testId="operations-page">
      <ShellHeader
        actions={
          <>
          <Link className="secondary-button" href={`/${appLocale}/app/reservations`}>
            {t("newReservation")}
          </Link>
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("backToWorkspace")}
          </Link>
          </>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      <section className="workspace-main">
        <div className="section-heading">
          <p className="panel-label">{t("listLabel")}</p>
          <span data-testid="operation-task-count">{t("count", { count: tasks.length })}</span>
        </div>
        {tasks.length === 0 ? (
          <EmptyState testId="operation-tasks-empty" tone="motif">{t("empty")}</EmptyState>
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
                <Link className="secondary-button" data-testid="task-whatsapp" href={whatsappComposerPath(appLocale, { type: "task", id: task.id })}>{whatsapp("title")}</Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </ManagerShell>
  );
}
