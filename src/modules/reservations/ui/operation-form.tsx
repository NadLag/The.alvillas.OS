"use client";
import { useActionState, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { operationAction, type OperationFormState } from "../application/operation-actions";
import { parseOperationForm } from "../domain/operation-task";

function subscribeOnline(callback: () => void) { window.addEventListener("online", callback); window.addEventListener("offline", callback); return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; }
const onlineSnapshot = () => navigator.onLine;
const serverOnlineSnapshot = () => true;
export function OperationForm({ locale, operation, children, taskId, version, submit, idempotencyKey }: {
  locale: string; operation: "create" | "transition" | "proxy"; children: ReactNode;
  taskId?: string; version?: number; submit?: string; idempotencyKey: string;
}) {
  const t = useTranslations("Operations.manage"), id = useId();
  const [state, action, pending] = useActionState<OperationFormState, FormData>(operationAction.bind(null, locale, operation), { status: "idle" });
  const online = useSyncExternalStore(subscribeOnline, onlineSnapshot, serverOnlineSnapshot);
  const [clientError, setClientError] = useState(false);
  return <form action={action} className="resource-form operation-form" data-testid={`operation-${operation}-form`} onSubmit={event => {
    try { parseOperationForm(operation, new FormData(event.currentTarget)); setClientError(false); }
    catch { event.preventDefault(); setClientError(true); }
  }}>
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
    {version ? <input type="hidden" name="expectedVersion" value={version} /> : null}
    {children}
    <label htmlFor={`${id}-reason`}>{t("reason")}<textarea id={`${id}-reason`} name="reason" required minLength={6} maxLength={1000} /></label>
    {!online ? <p role="status">{t("offline")}</p> : null}
    {clientError ? <p role="alert">{t("errors.validation")}</p> : null}
    {state.status === "error" ? <p role="alert">{t(`errors.${state.message ?? "generic"}`)}</p> : null}
    {state.status === "saved" ? <p role="status">{t("saved")}</p> : null}
    <button className="primary-button" disabled={pending || !online} type="submit">{pending ? t("saving") : submit ?? t("save")}</button>
  </form>;
}
