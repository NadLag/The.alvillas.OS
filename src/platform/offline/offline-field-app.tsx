"use client";

import { useEffect, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { z } from "zod";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import ar from "../../../messages/ar.json";
import { EmptyState, FieldShell, ShellHeader } from "@/design-system/shells";
import { formatDateTime } from "@/i18n/format";
import { localeDirection, type AppLocale } from "@/i18n/routing";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { localizedTaskTitle } from "@/modules/reservations/domain/reservation-task";
import { FieldTaskCompletionForm } from "@/modules/reservations/ui/reservation-forms";
import { FieldPwa } from "./field-pwa";
import { FieldLanguage } from "./field-language";
import { FieldJobs } from "./field-jobs";
import { fieldQueue } from "./field-queue";
import { type FieldQueueScope } from "./field-queue-store";
import { resolveFieldScope } from "./field-session";

function fieldMessages(messages: typeof en) {
  return { Field: messages.Field, FieldCache: messages.FieldCache, FieldPwa: messages.FieldPwa, Operations: { manage: messages.Operations.manage } };
}
const catalogs = { en: fieldMessages(en), fr: fieldMessages(fr), ar: fieldMessages(ar) };
export function OfflineFieldApp({ initialLocale }: { initialLocale: AppLocale }) {
  const [locale, setLocale] = useState(initialLocale);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = localeDirection(locale); }, [locale]);
  return <NextIntlClientProvider locale={locale} messages={catalogs[locale]}><OfflineWork locale={locale} changeLocale={setLocale} /></NextIntlClientProvider>;
}
function OfflineWork({ locale, changeLocale }: { locale: AppLocale; changeLocale: (locale: AppLocale) => void }) {
  const t = useTranslations("Field"), cache = useTranslations("FieldCache");
  const [scope, setScope] = useState<FieldQueueScope | null>(null), [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<FieldWorkSnapshot[]>([]), [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const queue = fieldQueue();
    const navigate = () => {
      const task = z.uuid().safeParse(new URLSearchParams(location.search).get("task"));
      setTaskId(task.success ? task.data : null);
    };
    const verify = async () => {
      const identity = await resolveFieldScope(queue, navigator.onLine);
      if (!disposed) { setScope(identity); setLoading(false); }
    };
    const verifyNow = () => { void verify().catch(() => { if (!disposed) { setScope(null); setLoading(false); } }); };
    queueMicrotask(() => { if (!disposed) { navigate(); verifyNow(); } });
    window.addEventListener("popstate", navigate); window.addEventListener("online", verifyNow); window.addEventListener("focus", verifyNow);
    return () => { disposed = true; window.removeEventListener("popstate", navigate); window.removeEventListener("online", verifyNow); window.removeEventListener("focus", verifyNow); };
  }, []);
  useEffect(() => {
    if (!scope) return;
    const subscription = liveQuery(() => fieldQueue().readCache(scope)).subscribe({ next: value => {
      setTasks(value.tasks); setSnapshotAt(value.state?.snapshotAt ?? null);
    }, error: () => { setScope(null); setTasks([]); setSnapshotAt(null); } });
    return () => subscription.unsubscribe();
  }, [scope]);
  const path = (nextLocale: AppLocale, id: string | null) => `/${nextLocale}/offline/field${id ? `?task=${id}` : ""}`;
  function openJob(id: string | null) { setTaskId(id); history.pushState(null, "", path(locale, id)); }
  function language(nextLocale: AppLocale) { changeLocale(nextLocale); history.replaceState(null, "", path(nextLocale, taskId)); }
  const task = tasks.find(item => item.id === taskId);
  return <div data-field-offline-shell="public"><FieldShell className="field-page field-detail" testId={taskId ? "field-task-page" : "field-page"}>
    <ShellHeader eyebrow={task?.propertyName ?? t("eyebrow")} title={task ? localizedTaskTitle(task.title, locale) : t("title")}
      titleTestId={task ? "field-task-title" : undefined} subtitle={task ? t("detailMeta", { reservation: task.reservationReference ?? t("noReservation"), guest: task.guestName ?? t("noGuest") }) : cache("offlineWork")}
      actions={taskId ? <button className="secondary-button" type="button" onClick={() => openJob(null)}>{t("backToJobs")}</button> : undefined} />
    <FieldLanguage locale={locale} path={`/offline/field${taskId ? `?task=${taskId}` : ""}`} onChangeLocale={language} />
    {loading ? <p role="status">{cache("preparing")}</p> : !scope ? <EmptyState testId="field-cache-sign-in"><span>{cache("signIn")}</span> <a className="primary-button" href={`/${locale}/login?surface=field`}>{cache("signInAction")}</a></EmptyState> : <>
      <FieldPwa organizationId={scope.organizationId} userId={scope.userId} />
      {snapshotAt ? <p>{cache("lastUpdated", { time: formatDateTime(locale, new Date(snapshotAt)) })}</p> : null}
      {taskId ? task ? <CachedChecklist key={task.id} task={task} scope={scope} locale={locale} /> : <EmptyState testId="field-cache-missing">{cache("unavailable")}</EmptyState>
        : <FieldJobs scope={scope} locale={locale} initial={tasks} openJob={openJob} />}
    </>}
  </FieldShell></div>;
}
function CachedChecklist({ task, scope, locale }: { task: FieldWorkSnapshot; scope: FieldQueueScope; locale: AppLocale }) {
  const t = useTranslations("Field"), cache = useTranslations("FieldCache"), key = useRef<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  useEffect(() => { queueMicrotask(() => { key.current ??= crypto.randomUUID(); setIdempotencyKey(key.current); }); }, []);
  if (!idempotencyKey) return <p role="status">{cache("preparing")}</p>;
  return <>
    <p>{task.propertyAddress}</p><p>{cache("dueDate", { date: task.dueDate, timezone: task.propertyTimezone })}</p>
    {!task.canEdit ? <p role="status">{cache("readOnly")}</p> : null}
    <FieldTaskCompletionForm locale={locale} taskId={task.id} idempotencyKey={idempotencyKey} userId={scope.userId} organizationId={scope.organizationId}
      checklistItems={task.checklistItems} mode="cached" readOnly={!task.canEdit} labels={{
        saving: t("saving"), validation: t("forms.validation"), unauthorized: t("forms.unauthorized"), forbidden: t("forms.forbidden"),
        notFound: t("forms.notFound"), config: t("forms.generic"), conflict: t("forms.conflict"), generic: t("forms.generic"),
        complete: t("complete"), completing: t("completing"), note: t("note"), offlineQueued: t("offlineQueued"), offlineSyncing: t("offlineSyncing"),
        offlineSynced: t("offlineSynced"), offlineConflict: t("offlineConflict"), offlineRejected: t("offlineRejected"), offlineStorageError: t("offlineStorageError")
      }} />
  </>;
}
