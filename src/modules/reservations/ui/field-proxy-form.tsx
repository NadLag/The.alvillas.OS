"use client";

import { startTransition, useActionState, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { operationAction, type OperationFormState } from "../application/operation-actions";
import { parseOperationForm } from "../domain/operation-task";
import { useFieldProxyDraft } from "@/platform/offline/use-field-proxy-draft";
import { localizedTaskTitle } from "../domain/reservation-task";

function subscribe(callback: () => void) { window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; }
const isOnline = () => navigator.onLine, serverOnline = () => true;

export function FieldProxyForm({ locale, taskId, version, performerId, idempotencyKey, checklist, organizationId, userId, cached = false }: {
  locale: string; taskId: string; version: number; performerId: string; idempotencyKey: string;
  checklist: Array<{ id: string; label: string }>; organizationId: string; userId: string; cached?: boolean;
}) {
  const t = useTranslations("FieldProxy"), errors = useTranslations("Operations.manage.errors");
  const cache = useTranslations("FieldCache");
  const router = useRouter();
  const [state, action, pending] = useActionState<OperationFormState, FormData>(operationAction.bind(null, locale, "proxy"), { status: "idle" });
  const draft = useFieldProxyDraft({ organizationId, userId }, { taskId, expectedVersion: version, performedByPersonId: performerId,
    clientOpId: idempotencyKey, checklistItemIds: [], reason: "" });
  const { value, setValue } = draft, checked = new Set(value.checklistItemIds), reason = value.reason;
  const [invalid, setInvalid] = useState(false), [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [submittedNonce, setSubmittedNonce] = useState<string | null>(null);
  const [navigationBlocked, setNavigationBlocked] = useState(false), dirty = !draft.queued && (checked.size > 0 || Boolean(reason));
  const items = draft.task && !draft.reviewRequired ? draft.task.checklistItems.map(item => ({ id: item.id, label: localizedTaskTitle(item.label, locale) })) : checklist;
  const online = useSyncExternalStore(subscribe, isOnline, serverOnline);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const leave = (event: MouseEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const link = event.target instanceof Element ? event.target.closest("a") : null;
      if (!link || link.target || link.closest('[data-testid="field-language"]')) return;
      if (new URL(link.href).href === location.href) return;
      event.preventDefault(); event.stopPropagation(); setNavigationBlocked(true);
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  if (draft.sessionChanged) return <p role="status" data-testid="field-proxy-session-changed">{cache("signIn")}</p>;
  return <form className="resource-form field-checklist field-proxy-form" data-testid="field-proxy-form" data-field-dirty={dirty ? "true" : "false"}
    action={action} onReset={event => event.preventDefault()} onSubmit={event => {
      event.preventDefault(); if (pending || saving || reviewing || draft.queued || draft.reviewRequired) return;
      const data = new FormData(event.currentTarget);
      try {
        parseOperationForm("proxy", data); setInvalid(false);
        if (cached || !online || draft.queueRequired) {
          setSaving(true); void draft.enqueue().catch(() => draft.setStorageError(true)).finally(() => setSaving(false));
        } else { setSubmittedNonce(value.clientOpId); startTransition(() => action(data)); }
      } catch { setInvalid(true); }
    }}>
    <input type="hidden" name="taskId" value={taskId} /><input type="hidden" name="expectedVersion" value={value.expectedVersion} />
    <input type="hidden" name="performedByPersonId" value={value.performedByPersonId} /><input type="hidden" name="idempotencyKey" value={value.clientOpId} />
    <fieldset disabled={pending || saving || reviewing || draft.queued || !draft.ready || draft.reviewRequired}><legend>{t("checklist")}</legend>
      {items.map(item => <label className="field-checklist-item" key={item.id}>
        <input type="checkbox" name="checklistItemIds" value={item.id} checked={checked.has(item.id)} onChange={event => {
          const next = new Set(checked); if (event.target.checked) next.add(item.id); else next.delete(item.id);
          setValue(current => ({ ...current, checklistItemIds: [...next] }));
        }} required /><span>{item.label}</span></label>)}
    </fieldset>
    <p role="status">{t("progress", { count: checked.size, total: items.length })}</p>
    <label htmlFor="field-proxy-reason">{t("reason")}</label><textarea id="field-proxy-reason" name="reason" dir="auto" required minLength={6} maxLength={1000}
      disabled={pending || saving || reviewing || draft.queued || !draft.ready || draft.reviewRequired} value={reason} onChange={event => setValue(current => ({ ...current, reason: event.target.value }))} />
    {!online ? <p role="status" data-testid="field-proxy-offline">{t("offline")}</p> : null}
    {draft.queued ? <p role="status" data-testid="field-proxy-queued">{t("queued")}</p> : null}
    {draft.reviewRequired ? <div aria-busy={reviewing}><p role="status" data-testid="field-proxy-review-required">{t("reviewRequired")}</p>
      {draft.task?.proxyValidation ? <dl><dt>{t("performedBy")}</dt><dd>{draft.task.proxyValidation.performerName ?? draft.task.proxyValidation.performedByPersonId}</dd></dl> : null}
      <button className="secondary-button" type="button" disabled={!draft.task || draft.queued || reviewing} data-testid="field-proxy-review" onClick={() => {
        setReviewing(true); void draft.review().then(reviewed => { if (reviewed) { setInvalid(false); if (online && !cached) router.refresh(); } }).finally(() => setReviewing(false));
      }}>{t("review")}</button></div> : null}
    {draft.storageError ? <p role="status" data-testid="field-proxy-storage-error">{t("storageError")}</p> : null}
    {!online && !draft.canQueue ? <p role="status">{t("notPrepared")}</p> : null}
    {navigationBlocked ? <p role="status" data-testid="field-proxy-unsaved">{t("unsaved")}</p> : null}
    {invalid || (state.status === "error" && submittedNonce === value.clientOpId && !pending) ? <p role="alert" data-testid="field-proxy-error">{errors(invalid ? "validation" : state.message ?? "generic")}</p> : null}
    <button className="primary-button" type="submit" disabled={pending || saving || reviewing || !draft.ready || draft.queued || draft.reviewRequired || (!online && !draft.canQueue) || checked.size !== items.length || !reason.trim()} data-testid="field-proxy-submit">
      {t(pending || saving ? "saving" : "submit")}</button>
  </form>;
}
