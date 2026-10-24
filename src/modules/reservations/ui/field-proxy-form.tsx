"use client";

import { startTransition, useActionState, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { operationAction, type OperationFormState } from "../application/operation-actions";
import { parseOperationForm } from "../domain/operation-task";

function subscribe(callback: () => void) { window.addEventListener("online", callback); window.addEventListener("offline", callback);
  return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; }
const isOnline = () => navigator.onLine, serverOnline = () => true;

export function FieldProxyForm({ locale, taskId, version, performerId, idempotencyKey, checklist }: {
  locale: string; taskId: string; version: number; performerId: string; idempotencyKey: string;
  checklist: Array<{ id: string; label: string }>;
}) {
  const t = useTranslations("FieldProxy"), errors = useTranslations("Operations.manage.errors");
  const [state, action, pending] = useActionState<OperationFormState, FormData>(operationAction.bind(null, locale, "proxy"), { status: "idle" });
  const [checked, setChecked] = useState(new Set<string>()), [reason, setReason] = useState(""), [invalid, setInvalid] = useState(false);
  const [navigationBlocked, setNavigationBlocked] = useState(false), dirty = checked.size > 0 || Boolean(reason);
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
  return <form className="resource-form field-checklist field-proxy-form" data-testid="field-proxy-form" data-field-dirty={checked.size || reason ? "true" : "false"}
    action={action} onReset={event => event.preventDefault()} onSubmit={event => {
      event.preventDefault(); if (pending || !online) return;
      const data = new FormData(event.currentTarget);
      try { parseOperationForm("proxy", data); setInvalid(false); startTransition(() => action(data)); } catch { setInvalid(true); }
    }}>
    <input type="hidden" name="taskId" value={taskId} /><input type="hidden" name="expectedVersion" value={version} />
    <input type="hidden" name="performedByPersonId" value={performerId} /><input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <fieldset disabled={pending}><legend>{t("checklist")}</legend>
      {checklist.map(item => <label className="field-checklist-item" key={item.id}>
        <input type="checkbox" name="checklistItemIds" value={item.id} checked={checked.has(item.id)} onChange={event => setChecked(value => {
          const next = new Set(value); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next;
        })} required /><span>{item.label}</span></label>)}
    </fieldset>
    <p role="status">{t("progress", { count: checked.size, total: checklist.length })}</p>
    <label htmlFor="field-proxy-reason">{t("reason")}</label><textarea id="field-proxy-reason" name="reason" dir="auto" required minLength={6} maxLength={1000}
      disabled={pending} value={reason} onChange={event => setReason(event.target.value)} />
    {!online ? <p role="status" data-testid="field-proxy-offline">{t("offline")}</p> : null}
    {navigationBlocked ? <p role="status" data-testid="field-proxy-unsaved">{t("unsaved")}</p> : null}
    {invalid || state.status === "error" ? <p role="alert" data-testid="field-proxy-error">{errors(invalid ? "validation" : state.message ?? "generic")}</p> : null}
    <button className="primary-button" type="submit" disabled={!online || pending || checked.size !== checklist.length || !reason.trim()} data-testid="field-proxy-submit">
      {t(pending ? "saving" : "submit")}</button>
  </form>;
}
