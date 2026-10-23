import { OperationEvidencePanel } from "@/modules/reservations/ui/operation-evidence-panel";
import { FieldPwa } from "@/platform/offline/field-pwa";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { FieldShell, ShellHeader } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  ReservationNotFoundError,
  getAssignedFieldTask
} from "@/modules/reservations/application/reservation-service";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { FieldTaskCompletionForm } from "@/modules/reservations/ui/reservation-forms";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";
import { whatsappComposerPath } from "@/platform/notifications/whatsapp-path";

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
  const ctx = await reservationActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations({locale,namespace:"Field"});
  const whatsapp = await getTranslations({locale,namespace:"Whatsapp"});
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
    <FieldShell className="field-page field-detail" testId="field-task-page">
      <ShellHeader
        actions={
        <Link className="secondary-button" href={`/${appLocale}/app/field`}>
          {t("backToJobs")}
        </Link>
        }
        eyebrow={task.propertyName}
        subtitle={t("detailMeta", {
          reservation: task.reservationReference ?? t("noReservation"),
          guest: task.guestName ?? t("noGuest")
        })}
        title={localizedTaskTitle(task.title, appLocale)}
        titleTestId="field-task-title"
      />

      <FieldPwa organizationId={ctx.organizationId} userId={ctx.actorId} />
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
          offlineRejected: t("offlineRejected"),
          offlineStorageError: t("offlineStorageError")
        }}
        locale={appLocale}
        idempotencyKey={randomUUID()}
        userId={ctx.actorId}
        organizationId={ctx.organizationId}
        taskId={task.id}
      />
      <Link className="secondary-button whatsapp-entry" data-testid="task-whatsapp" href={whatsappComposerPath(appLocale, { type: "task", id: task.id })}>{whatsapp("title")}</Link>
      <OperationEvidencePanel ctx={ctx} taskId={task.id} locale={appLocale} />
    </FieldShell>
  );
}
