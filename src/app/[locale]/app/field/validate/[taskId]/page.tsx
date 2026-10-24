import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { FieldShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { authorize } from "@/platform/authz/authorize";
import { FieldLanguage } from "@/platform/offline/field-language";
import { FieldPwa } from "@/platform/offline/field-pwa";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationTaskDetail, taskResource } from "@/modules/reservations/application/operation-service";
import { ReservationAuthorizationError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import { taskEvidence } from "@/modules/reservations/application/operation-evidence";
import { taskText } from "@/modules/reservations/domain/operation-task";
import { FieldProxyForm } from "@/modules/reservations/ui/field-proxy-form";
import { OperationForm } from "@/modules/reservations/ui/operation-form";

export const dynamic = "force-dynamic";
export default async function ProxyTaskPage({ params }: { params: Promise<{ locale: string; taskId: string }> }) {
  const path = await params, locale = safeLocale(path.locale); setRequestLocale(locale);
  const session = await auth(); if (session?.user?.id && session.user.securitySetupRequired) redirect(`/${locale}/app/security`);
  const ctx = await reservationActorContextFromSession(session); if (!ctx) redirect(`/${locale}/login?surface=field`);
  if (!z.uuid().safeParse(path.taskId).success) notFound();
  let detail;
  try { detail = await operationTaskDetail(ctx, path.taskId); }
  catch (error) { if (error instanceof ReservationAuthorizationError || error instanceof ReservationNotFoundError) notFound(); throw error; }
  const { task, people } = detail, resource = taskResource(task);
  if (!authorize(ctx.authContext, "validate", resource) || !task.assignedToPersonId ||
    task.assignedToPersonId === ctx.personId || task.assignedToUserAccountId === ctx.actorId) notFound();
  const canComplete = ["ASSIGNED", "IN_PROGRESS"].includes(task.state), completed = task.state === "COMPLETED" && task.completionSource === "PROXY";
  if (!canComplete && !completed) notFound();
  const [t, format, evidence] = await Promise.all([getTranslations("FieldProxy"), getFormatter(), taskEvidence(ctx, task.id)]);
  const person = (id: string | null) => id ? people[id] ?? id : t("you");
  return <FieldShell className="field-page field-detail" testId="field-proxy-page">
    <ShellHeader eyebrow={task.property.name} title={localizedText(taskText(task.titleTranslations), locale)} subtitle={t("help")}
      actions={<Link className="secondary-button" href={`/${locale}/app/field/validate`}>{t("backToValidation")}</Link>} />
    <FieldLanguage locale={locale} path={`/app/field/validate/${task.id}`} />
    <FieldPwa organizationId={ctx.organizationId} userId={ctx.actorId} audience="supervised" />
    <dl className="field-proxy-identities" data-testid="field-proxy-identities">
      <div><dt>{t("performedBy")}</dt><dd>{person(task.completedByPersonId ?? task.assignedToPersonId)}</dd></div>
      <div><dt>{t("validatedBy")}</dt><dd>{completed ? person(task.validatedByPersonId) : session?.user?.name ?? t("you")}</dd></div>
      {completed && task.validatedAt ? <><div><dt>{t("validatedAt")}</dt><dd>{format.dateTime(task.validatedAt, { dateStyle: "medium", timeStyle: "short", timeZone: task.property.timezone })}</dd></div>
        <div><dt>{t("reason")}</dt><dd>{task.validationReason}</dd></div></> : null}
    </dl>
    {completed ? <p role="status" data-testid="field-proxy-completed">{t("completed")}</p> : <FieldProxyForm locale={locale} taskId={task.id}
      version={task.version} performerId={task.assignedToPersonId} idempotencyKey={randomUUID()}
      key={`${ctx.organizationId}:${ctx.actorId}:${task.id}`} organizationId={ctx.organizationId} userId={ctx.actorId}
      checklist={task.checklistItems.map(item => ({ id: item.id, label: localizedText(taskText(item.labelTranslations), locale) }))} />}
    <details className="panel" data-testid="field-proxy-evidence"><summary>{t("evidence")}</summary>
      <p>{t("evidenceHelp")}</p>
      {evidence.evidence.length ? <ul>{evidence.evidence.map(row => <li key={row.id}><p>{row.note}</p>
        {row.contentType ? <a href={`/api/operations/evidence/${row.id}`} target="_blank" rel="noopener noreferrer">{t("viewPhoto")}</a> : null}</li>)}</ul> : null}
      {canComplete && authorize(ctx.authContext, "edit", resource) ? <OperationForm operation="evidence" locale={locale} taskId={task.id}
        idempotencyKey={randomUUID()} submit={t("saveEvidence")}><label>{t("photo")}<input type="file" name="file" accept="image/jpeg,image/png" capture="environment" /></label></OperationForm> : null}
    </details>
  </FieldShell>;
}
