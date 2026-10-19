import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { localizedText } from "@/i18n/content";
import { auth } from "@/platform/auth/session";
import { authorize } from "@/platform/authz/authorize";
import { ManagerShell, ShellHeader } from "@/design-system/shells";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import { operationTaskDetail, taskResource } from "@/modules/reservations/application/operation-service";
import { ReservationAuthorizationError, ReservationNotFoundError } from "@/modules/reservations/application/reservation-service";
import { canTransitionTask, taskStates, taskText } from "@/modules/reservations/domain/operation-task";
import { OperationForm } from "@/modules/reservations/ui/operation-form";
export const dynamic = "force-dynamic";
export default async function TaskPage({ params, searchParams }: { params: Promise<{ locale: string; taskId: string }>; searchParams: Promise<{ before?: string }> }) {
  const path = await params, locale = safeLocale(path.locale); setRequestLocale(locale);
  const ctx = await reservationActorContextFromSession(await auth()); if (!ctx) redirect(`/${locale}/login`);
  const [t, format] = await Promise.all([getTranslations("Operations.manage"), getFormatter()]);
  let model;
  try { const before = (await searchParams).before; model = await operationTaskDetail(ctx, path.taskId, before ? Number(before) : undefined); }
  catch (error) { if (error instanceof ReservationNotFoundError || error instanceof ReservationAuthorizationError) notFound(); throw error; }
  const { task, events, nextVersion, people, actors } = model, resource = taskResource(task);
  const personLabel = (id: string | null) => id ? people[id] ?? id : t("pending");
  const states = taskStates.filter(s => !["ASSIGNED", "COMPLETED"].includes(s) && canTransitionTask(task.state, s));
  return <ManagerShell className="resource-page" testId="operation-detail-page">
    <ShellHeader eyebrow={task.property.name} title={localizedText(taskText(task.titleTranslations), locale)} subtitle={t("taskMeta", { state: t(`states.${task.state}`), date: format.dateTime(task.dueDate, { dateStyle: "medium", timeZone: "UTC" }) })} actions={<Link className="secondary-button" href={`/${locale}/app/operations`}>{t("back")}</Link>} />
    <div className="workspace-main operation-detail-grid">
      <section className="panel"><h2>{t("checklist")}</h2><p>{t("progress", { done: task.checklistItems.filter(i => i.completedAt).length, total: task.checklistItems.length })}</p>
        <ul>{task.checklistItems.map(i => <li key={i.id}>{localizedText(taskText(i.labelTranslations), locale)} — {i.completedAt ? t("checked") : t("pending")}</li>)}</ul>
        <dl><dt>{t("assignedTo")}</dt><dd>{task.assignedToPersonId ? personLabel(task.assignedToPersonId) : t("unassigned")}</dd><dt>{t("performedBy")}</dt><dd data-testid="task-performed-by" data-person-id={task.completedByPersonId}>{personLabel(task.completedByPersonId)}</dd><dt>{t("validatedBy")}</dt><dd data-testid="task-validated-by" data-person-id={task.validatedByPersonId}>{task.validatedByPersonId ? personLabel(task.validatedByPersonId) : t("selfValidation")}</dd></dl>
        {task.validationReason ? <p>{task.validationReason}</p> : null}
        {task.validatedAt ? <p>{format.dateTime(task.validatedAt, { dateStyle: "medium", timeStyle: "short" })}</p> : null}
        {task.assignedToUserAccountId === ctx.actorId && !["COMPLETED", "CANCELLED", "SKIPPED"].includes(task.state) ? <Link className="primary-button" href={`/${locale}/app/field/${task.id}`}>{t("openChecklist")}</Link> : null}
      </section>
      {authorize(ctx.authContext, "edit", resource) && states.length ? <section className="panel"><h2>{t("changeState")}</h2><OperationForm idempotencyKey={randomUUID()} operation="transition" locale={locale} taskId={task.id} version={task.version}><label>{t("state")}<select name="state">{states.map(s => <option value={s} key={s}>{t(`states.${s}`)}</option>)}</select></label></OperationForm></section> : null}
      {authorize(ctx.authContext, "validate", resource) && task.assignedToPersonId && task.assignedToPersonId !== ctx.personId && ["ASSIGNED", "IN_PROGRESS"].includes(task.state) ? <section className="panel"><h2>{t("proxy")}</h2><p>{t("proxyHelp")}</p><OperationForm idempotencyKey={randomUUID()} operation="proxy" locale={locale} taskId={task.id} version={task.version} submit={t("proxy")}>
        <input type="hidden" name="performedByPersonId" value={task.assignedToPersonId} />
        <p>{t("performedBy")}: {personLabel(task.assignedToPersonId)}</p><p>{t("validatedBy")}: {ctx.personId}</p>
        <fieldset><legend>{t("confirmChecklist")}</legend>{task.checklistItems.map(i => <label className="field-checklist-item" key={i.id}><input type="checkbox" name="checklistItemIds" value={i.id} required />{localizedText(taskText(i.labelTranslations), locale)}</label>)}</fieldset>
      </OperationForm></section> : null}
      <section className="panel"><h2>{t("history")}</h2><ol className="resource-list">{events.map(event => {
        const data = event.after as Record<string, unknown>;
        return <li key={event.id} data-testid="task-history-event"><strong>{t("version", { version: event.version })} · {t(`events.${event.kind}`)}</strong><p>{format.dateTime(event.occurredAt, { dateStyle: "medium", timeStyle: "short" })}</p><p>{event.actorId ? actors[event.actorId] ?? event.actorId : t("unattributed")}</p><p>{event.reason}</p><p>{t(`states.${String(data.state)}`)} · {t(`priorities.${String(data.priority)}`)}</p><p>{typeof data.due_date === "string" ? format.dateTime(new Date(data.due_date), { dateStyle: "medium", timeZone: "UTC" }) : null}</p><p>{t("assignedTo")}: {typeof data.assigned_to_person_id === "string" ? people[data.assigned_to_person_id] ?? data.assigned_to_person_id : t("unassigned")}</p></li>;
      })}</ol>{nextVersion ? <Link href={`/${locale}/app/operations/${task.id}?before=${nextVersion}`}>{t("olderHistory")}</Link> : null}</section>
    </div>
  </ManagerShell>;
}
