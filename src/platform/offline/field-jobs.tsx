"use client";

import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/design-system/shells";
import type { AppLocale } from "@/i18n/routing";
import { fieldPullPageSize, type FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { fieldQueue } from "./field-queue";
import type { FieldCacheAudience, FieldQueueScope } from "./field-queue-store";
import { resolveFieldScope } from "./field-session";

export function FieldJobs({ scope, locale, initial = [], openJob, audience = "assigned" }: { scope: FieldQueueScope; locale: AppLocale; initial?: FieldWorkSnapshot[]; openJob?: (id: string) => void; audience?: FieldCacheAudience }) {
  const t = useTranslations("Field"), cache = useTranslations("FieldCache");
  const [tasks, setTasks] = useState(initial), [mode, setMode] = useState<"today" | "assigned">("today"), [limit, setLimit] = useState(fieldPullPageSize);
  const { organizationId, userId } = scope;
  useEffect(() => {
    let disposed = false, subscription: { unsubscribe(): void } | undefined;
    const queue = fieldQueue();
    const owner = { organizationId, userId };
    void resolveFieldScope(queue, navigator.onLine, owner).then(verified => {
      if (!verified) { setTasks([]); return; }
      if (disposed) return;
      subscription = liveQuery(() => queue.readCache(owner, audience)).subscribe({ next: value => {
        if (value.state?.snapshotAt || value.state?.invalidated) setTasks(value.tasks);
      }, error: () => setTasks([]) });
    }).catch(() => { /* The authenticated server snapshot remains usable when storage is unavailable. */ });
    return () => { disposed = true; subscription?.unsubscribe(); };
  }, [organizationId, userId, audience]);
  const rows = tasks.filter(task => mode === "assigned" || task.dueDate <= task.businessDate)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id));
  return <>
    <div className="form-actions field-work-views" role="group" aria-label={cache("views")}>
      <button className="secondary-button" type="button" aria-pressed={mode === "today"} data-testid="field-view-today" onClick={() => { setMode("today"); setLimit(fieldPullPageSize); }}>{cache("today")}</button>
      <button className="secondary-button" type="button" aria-pressed={mode === "assigned"} data-testid="field-view-assigned" onClick={() => { setMode("assigned"); setLimit(fieldPullPageSize); }}>{cache("assigned")}</button>
    </div>
    {rows.length ? <div className="field-task-list">{rows.slice(0, limit).map(task => <a className="field-task-card" data-testid="field-task-card"
      href={`/${locale}/app/field/${audience === "supervised" ? "validate/" : ""}${task.id}`} key={task.id} onClick={event => {
        if (openJob && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openJob(task.id); }
      }}>
      <span><strong>{localizedTaskTitle(task.title, locale)}</strong><small>{t("rowMeta", { property: task.propertyName, reservation: task.reservationReference ?? t("noReservation") })}</small></span>
      <span>{t("checklistCount", { count: task.checklistItems.length })}</span>
    </a>)}</div> : <EmptyState testId="field-tasks-empty" tone="motif">{t("empty")}</EmptyState>}
    {rows.length > limit ? <button className="secondary-button field-complete-button" data-testid="field-load-more" type="button" onClick={() => setLimit(value => value + fieldPullPageSize)}>{cache("loadMore")}</button> : null}
  </>;
}
