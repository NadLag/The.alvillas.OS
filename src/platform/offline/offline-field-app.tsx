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
import { FieldPhotoCapture } from "./field-photo-capture";
import { FieldIssueCapture } from "./field-issue-capture";
import { FieldWallet } from "./field-wallet";
import { FieldInventory, FieldLinen } from "./field-linen";
import { FieldProxyForm } from "@/modules/reservations/ui/field-proxy-form";
import type { FieldCacheAudience } from "./field-queue-store";

function fieldMessages(messages: typeof en) {
  return { Field: messages.Field, FieldProxy: messages.FieldProxy, FieldLinen: messages.FieldLinen, FieldInventory: messages.FieldInventory, FieldCache: messages.FieldCache, FieldPwa: messages.FieldPwa, FieldPhoto: messages.FieldPhoto, FieldIssue: messages.FieldIssue, FieldWallet: messages.FieldWallet, Operations: { manage: messages.Operations.manage } };
}
const catalogs = { en: fieldMessages(en), fr: fieldMessages(fr), ar: fieldMessages(ar) };
export function OfflineFieldApp({ initialLocale }: { initialLocale: AppLocale }) {
  const [locale, setLocale] = useState(initialLocale);
  useEffect(() => { document.documentElement.lang = locale; document.documentElement.dir = localeDirection(locale); }, [locale]);
  return <NextIntlClientProvider locale={locale} messages={catalogs[locale]}><OfflineWork locale={locale} changeLocale={setLocale} /></NextIntlClientProvider>;
}
function OfflineWork({ locale, changeLocale }: { locale: AppLocale; changeLocale: (locale: AppLocale) => void }) {
  const t = useTranslations("Field"), cache = useTranslations("FieldCache"), proxy = useTranslations("FieldProxy");
  const [scope, setScope] = useState<FieldQueueScope | null>(null), [loading, setLoading] = useState(true);
  const [tasks, setTasks] = useState<FieldWorkSnapshot[]>([]), [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(false), [walletAvailable, setWalletAvailable] = useState(false), wallet = useTranslations("FieldWallet");
  const [audience, setAudience] = useState<FieldCacheAudience>("assigned");
  const [issueBlocked, setIssueBlocked] = useState(false), issue = useTranslations("FieldIssue");
  const [photoBlocked, setPhotoBlocked] = useState(false), photo = useTranslations("FieldPhoto");
  const [linenBlocked, setLinenBlocked] = useState(false), linen = useTranslations("FieldLinen");
  const [inventoryBlocked, setInventoryBlocked] = useState(false), inventory = useTranslations("FieldInventory");
  useEffect(() => {
    let disposed = false;
    const queue = fieldQueue();
    const navigate = () => {
      const query = new URLSearchParams(location.search), task = z.uuid().safeParse(query.get("task"));
      setTaskId(task.success ? task.data : null);
      setWalletOpen(query.get("view") === "wallet");
      setAudience(query.get("view") === "supervised" ? "supervised" : "assigned");
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
    const subscription = liveQuery(() => fieldQueue().readCache(scope, audience)).subscribe({ next: value => {
      setTasks(value.tasks); setWalletAvailable(Boolean(value.state?.wallet)); setSnapshotAt(value.state?.snapshotAt ?? null);
    }, error: () => { setScope(null); setTasks([]); setSnapshotAt(null); } });
    return () => subscription.unsubscribe();
  }, [scope, audience]);
  const path = (nextLocale: AppLocale, id: string | null, showWallet = false) => {
    const query = new URLSearchParams(); if (showWallet) query.set("view", "wallet"); else if (audience === "supervised") query.set("view", "supervised"); if (id) query.set("task", id);
    return `/${nextLocale}/offline/field${query.size ? `?${query}` : ""}`;
  };
  function openJob(id: string | null) {
    if (document.querySelector('[data-field-issue-dirty="true"]')) { setIssueBlocked(true); return; }
    setIssueBlocked(false);
    if (document.querySelector('[data-field-inventory-dirty="true"]')) { setInventoryBlocked(true); return; }
    setInventoryBlocked(false);
    if (document.querySelector('[data-field-linen-dirty="true"]')) { setLinenBlocked(true); return; }
    setLinenBlocked(false);
    if (document.querySelector('[data-field-photo-dirty="true"]') ||
      (audience === "supervised" && document.querySelector('[data-field-dirty="true"]'))) { setPhotoBlocked(true); return; }
    setPhotoBlocked(false); setWalletOpen(false); setTaskId(id); history.pushState(null, "", path(locale, id));
  }
  function language(nextLocale: AppLocale) { changeLocale(nextLocale); history.replaceState(null, "", path(nextLocale, taskId, walletOpen)); }
  const task = tasks.find(item => item.id === taskId);
  return <div data-field-offline-shell="public"><FieldShell className="field-page field-detail" testId={walletOpen ? "field-wallet-page" : taskId ? "field-task-page" : "field-page"}>
    <ShellHeader eyebrow={task?.propertyName ?? (audience === "supervised" ? proxy("eyebrow") : t("eyebrow"))} title={walletOpen ? wallet("title") : task ? localizedTaskTitle(task.title, locale) : audience === "supervised" ? proxy("title") : t("title")}
      titleTestId={task ? "field-task-title" : undefined} subtitle={walletOpen ? wallet("subtitle") : task ? t("detailMeta", { reservation: task.reservationReference ?? t("noReservation"), guest: task.guestName ?? t("noGuest") }) : cache("offlineWork")}
      actions={walletOpen || taskId ? <button className="secondary-button" type="button" onClick={() => openJob(null)}>{walletOpen ? wallet("back") : audience === "supervised" ? proxy("backToValidation") : t("backToJobs")}</button> : undefined} />
    <FieldLanguage locale={locale} path={path(locale, taskId, walletOpen).replace(`/${locale}`, "")} onChangeLocale={language} />
    {issueBlocked ? <p role="status" data-testid="field-issue-navigation-blocked">{issue("unsaved")}</p> : null}
    {photoBlocked ? <p role="status" data-testid="field-photo-navigation-blocked">{audience === "supervised" ? proxy("unsaved") : photo("unsaved")}</p> : null}
    {linenBlocked ? <p role="status" data-testid="field-linen-navigation-blocked">{linen("unsaved")}</p> : null}
    {inventoryBlocked ? <p role="status" data-testid="field-inventory-navigation-blocked">{inventory("unsaved")}</p> : null}
    {loading ? <p role="status">{cache("preparing")}</p> : !scope ? <EmptyState testId="field-cache-sign-in"><span>{cache("signIn")}</span> <a className="primary-button" href={`/${locale}/login?surface=field`}>{cache("signInAction")}</a></EmptyState> : <>
      <FieldPwa organizationId={scope.organizationId} userId={scope.userId} audience={audience} />
      {snapshotAt ? <p>{cache("lastUpdated", { time: formatDateTime(locale, new Date(snapshotAt)) })}</p> : null}
      {!walletOpen && !taskId && walletAvailable ? <button className="secondary-button" type="button" data-testid="field-wallet-entry" onClick={() => { setWalletOpen(true); history.pushState(null, "", path(locale, null, true)); }}>{wallet("title")}</button> : null}
      {walletOpen ? <FieldWallet scope={scope} locale={locale} /> : taskId ? task ? audience === "supervised" ? <CachedProxy key={`${scope.organizationId}:${scope.userId}:${task.id}`} task={task} scope={scope} locale={locale} /> : <CachedChecklist key={task.id} task={task} scope={scope} locale={locale} /> : <EmptyState testId="field-cache-missing">{cache("unavailable")}</EmptyState>
        : <FieldJobs scope={scope} locale={locale} initial={tasks} openJob={openJob} audience={audience} />}
    </>}
  </FieldShell></div>;
}
function CachedProxy({ task, scope, locale }: { task: FieldWorkSnapshot; scope: FieldQueueScope; locale: AppLocale }) {
  const t = useTranslations("FieldProxy"), cache = useTranslations("FieldCache"), key = useRef<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  useEffect(() => { queueMicrotask(() => { key.current ??= crypto.randomUUID(); setIdempotencyKey(key.current); }); }, []);
  if (!idempotencyKey || !task.proxyValidation) return <p role="status">{cache("preparing")}</p>;
  return <><p>{task.propertyAddress}</p><dl className="field-proxy-identities" data-testid="field-proxy-identities">
    <dt>{t("performedBy")}</dt><dd>{task.proxyValidation.performerName ?? task.proxyValidation.performedByPersonId}</dd>
    <dt>{t("validatedBy")}</dt><dd>{t("you")}</dd></dl>
    <FieldProxyForm locale={locale} taskId={task.id} version={task.proxyValidation.expectedVersion} performerId={task.proxyValidation.performedByPersonId}
      organizationId={scope.organizationId} userId={scope.userId} idempotencyKey={idempotencyKey} cached
      checklist={task.checklistItems.map(item => ({ id: item.id, label: localizedTaskTitle(item.label, locale) }))} /></>;
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
      beforeComplete={<><FieldLinen scope={scope} taskId={task.id} locale={locale} />
        <FieldInventory scope={scope} taskId={task.id} locale={locale} />
        <FieldIssueCapture scope={scope} taskId={task.id} />
        <FieldPhotoCapture key={`${scope.organizationId}:${scope.userId}:${task.id}`} scope={scope} taskId={task.id} /></>}
      checklistItems={task.checklistItems} mode="cached" readOnly={!task.canEdit} labels={{
        saving: t("saving"), validation: t("forms.validation"), unauthorized: t("forms.unauthorized"), forbidden: t("forms.forbidden"),
        notFound: t("forms.notFound"), config: t("forms.generic"), conflict: t("forms.conflict"), generic: t("forms.generic"),
        complete: t("complete"), completing: t("completing"), note: t("note"), offlineQueued: t("offlineQueued"), offlineSyncing: t("offlineSyncing"),
        offlineSynced: t("offlineSynced"), offlineConflict: t("offlineConflict"), offlineRejected: t("offlineRejected"), offlineStorageError: t("offlineStorageError")
      }} />
  </>;
}
