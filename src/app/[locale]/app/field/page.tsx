import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState, FieldShell, ShellHeader } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { listAssignedFieldTasks } from "@/modules/reservations/application/reservation-service";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function FieldTasksPage({
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

  const [t, tasks] = await Promise.all([getTranslations("Field"), listAssignedFieldTasks(ctx)]);

  return (
    <FieldShell className="field-page" testId="field-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("backToWorkspace")}
        </Link>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      {tasks.length === 0 ? (
        <EmptyState testId="field-tasks-empty" tone="motif">{t("empty")}</EmptyState>
      ) : (
        <div className="field-task-list">
          {tasks.map((task) => (
            <Link
              className="field-task-card"
              data-testid="field-task-card"
              href={`/${appLocale}/app/field/${task.id}`}
              key={task.id}
            >
              <span>
                <strong>{localizedTaskTitle(task.title, appLocale)}</strong>
                <small>
                  {t("rowMeta", {
                    property: task.propertyName,
                    reservation: task.reservationReference ?? t("noReservation")
                  })}
                </small>
              </span>
              <span>{t("checklistCount", { count: task.checklistItems.length })}</span>
            </Link>
          ))}
        </div>
      )}
    </FieldShell>
  );
}
