import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  ReservationNotFoundError,
  getAssignedFieldTask
} from "@/modules/reservations/application/reservation-service";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { FieldTaskCompletionForm } from "@/modules/reservations/ui/reservation-forms";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

export default async function FieldTaskPage({
  params
}: Readonly<{
  params: Promise<{ locale: string; taskId: string }>;
}>) {
  const { locale, taskId } = await params;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Field");
  let task;

  try {
    task = await getAssignedFieldTask(ctx, taskId);
  } catch (error) {
    if (error instanceof ReservationNotFoundError) {
      notFound();
    }

    throw error;
  }

  return (
    <section className="field-page field-detail" data-testid="field-task-page">
      <header className="field-header">
        <div>
          <p className="eyebrow">{task.propertyName}</p>
          <h1 data-testid="field-task-title">{localizedTaskTitle(task.title, appLocale)}</h1>
          <p>
            {t("detailMeta", {
              reservation: task.reservationReference ?? t("noReservation"),
              guest: task.guestName ?? t("noGuest")
            })}
          </p>
        </div>
        <Link className="secondary-button" href={`/${appLocale}/app/field`}>
          {t("backToJobs")}
        </Link>
      </header>

      <FieldTaskCompletionForm
        checklistItems={task.checklistItems.map((item) => ({
          id: item.id,
          label: item.label,
          completed: Boolean(item.completedAt)
        }))}
        labels={{
          saving: t("saving"),
          validation: t("forms.validation"),
          unauthorized: t("forms.unauthorized"),
          forbidden: t("forms.forbidden"),
          notFound: t("forms.notFound"),
          config: t("forms.generic"),
          conflict: t("forms.conflict"),
          generic: t("forms.generic"),
          complete: t("complete"),
          completing: t("completing"),
          note: t("note"),
          offlineQueued: t("offlineQueued"),
          offlineSyncing: t("offlineSyncing"),
          offlineSynced: t("offlineSynced"),
          offlineConflict: t("offlineConflict"),
          offlineRejected: t("offlineRejected")
        }}
        locale={appLocale}
        idempotencyKey={randomUUID()}
        userId={ctx.actorId}
        taskId={task.id}
      />
    </section>
  );
}
