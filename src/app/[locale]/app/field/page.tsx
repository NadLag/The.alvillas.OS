import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
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
    <section className="field-page" data-testid="field-page">
      <header className="field-header">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <Link className="secondary-button" href={`/${appLocale}/app`}>
          {t("backToWorkspace")}
        </Link>
      </header>

      {tasks.length === 0 ? (
        <p className="empty-state" data-testid="field-tasks-empty">
          {t("empty")}
        </p>
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
    </section>
  );
}
