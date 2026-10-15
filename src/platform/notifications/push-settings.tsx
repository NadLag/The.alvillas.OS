"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { pushRevokeAction, pushSettingsAction, pushSubscribeAction } from "./notification-actions";
import { browserPushPermission, pushSupported } from "./push-lifecycle";

type State = Extract<Awaited<ReturnType<typeof pushSettingsAction>>, { ok: true }>["data"];
export function PushSettings() {
  const t = useTranslations("Notifications.pushDelivery"); const notifications = useTranslations("Notifications.kinds"); const format = useFormatter();
  const [state, setState] = useState<State | null>(null); const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [pending, startTransition] = useTransition(); const [error, setError] = useState(false); const [offline, setOffline] = useState(false);
  const refresh = useCallback(() => {
    startTransition(async () => { try { const result = await pushSettingsAction(); if (result.ok) { setState(result.data); setError(false); } else setError(true); } catch { setError(true); } });
  }, []);
  useEffect(() => {
    refresh();
    const sync = () => { setOffline(!navigator.onLine); if (pushSupported()) void browserPushPermission().then(setPermission); else setPermission("unsupported"); };
    queueMicrotask(sync); window.addEventListener("online", sync); window.addEventListener("offline", sync); window.addEventListener("focus", sync);
    let permissionState: PermissionStatus | undefined;
    if (pushSupported()) void navigator.permissions?.query({ name: "notifications" }).then((value) => { permissionState = value; value.addEventListener("change", sync); }).catch(() => {});
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); window.removeEventListener("focus", sync); permissionState?.removeEventListener("change", sync); };
  }, [refresh]);
  function enable() {
    if (!state?.publicKey || !pushSupported()) return;
    const request = Notification.requestPermission();
    startTransition(async () => {
      setError(false);
      try {
        const result = await request; setPermission(result); if (result !== "granted") { await pushRevokeAction({ id: null, reason: "permission_revoked" }); return; }
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
        await navigator.serviceWorker.ready;
        const old = await registration.pushManager.getSubscription();
        if (old) await old.unsubscribe();
        const revoked = await pushRevokeAction({ id: null, reason: "subscription_changed" });
        if (!revoked.ok) throw new Error();
        const key = Uint8Array.from(atob(state.publicKey!.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.charCodeAt(0));
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        const saved = await pushSubscribeAction(subscription.toJSON());
        if (!saved.ok) { await subscription.unsubscribe(); throw new Error(); }
        refresh();
      } catch { setError(true); }
    });
  }
  function disable(id: string, currentSession: boolean) {
    startTransition(async () => { try {
      const revoked = await pushRevokeAction({ id, reason: "user_disabled" });
      if (!revoked.ok) throw new Error();
      if (currentSession && pushSupported()) { const registration = await navigator.serviceWorker.getRegistration("/"); await (await registration?.pushManager.getSubscription())?.unsubscribe(); }
      refresh();
    } catch { setError(true); } });
  }
  return <section className="notification-settings" aria-labelledby="push-delivery-title" aria-busy={pending}>
    <h2 id="push-delivery-title">{t("title")}</h2><p>{t("description")}</p><p>{t("installHint")}</p>
    {offline ? <p role="status">{t("offline")}</p> : null}
    {error ? <div role="alert"><p>{t("error")}</p><button type="button" className="secondary-button" onClick={refresh} disabled={pending || offline}>{t("retry")}</button></div> : null}
    {!state && !error ? <SkeletonBlock rows={3} /> : null}
    {state ? <>
      <p role="status" data-testid="push-permission">{t(permission)}</p>
      {!state.publicKey ? <p data-testid="push-not-configured">{t("notConfigured")}</p> : null}
      {state.publicKey && !state.deliveryReady ? <p data-testid="push-jobs-pending">{t("jobsPending")}</p> : null}
      <button type="button" className="primary-button" data-testid="push-enable" onClick={enable}
        disabled={pending || offline || !state.publicKey || permission === "denied" || permission === "unsupported"}>{t(pending ? "working" : "enable")}</button>
      <h3>{t("devices")}</h3>
      {!state.subscriptions.length ? <p>{t("noDevices")}</p> : <ul>{state.subscriptions.map((row) => <li className="notification-choice" key={row.id}>
        <span>{t(row.currentSession ? "thisDevice" : "otherDevice")} · {format.dateTime(new Date(row.createdAt), { dateStyle: "medium" })}</span>
        <button type="button" className="secondary-button" data-testid="push-disable" disabled={pending || offline} onClick={() => disable(row.id, row.currentSession)}>{t("disable")}</button>
      </li>)}</ul>}
      <h3>{t("history")}</h3><p>{t("historyDescription")}</p>
      {!state.items.length ? <p>{t("empty")}</p> : <ul data-testid="push-history">{state.items.map((row) => <li className="notification-channel" key={row.id}>
        <strong>{notifications(row.kind)}</strong><p>{t(row.openedAt ? "opened" : row.displayedAt ? "displayed" : `statuses.${row.status}`)}</p>
        <p>{t("attempts", { count: row.attemptCount })} · {format.dateTime(new Date(row.createdAt), { dateStyle: "medium", timeStyle: "short" })}</p>
        {row.errorCode ? <p>{t(`errors.${row.errorCode}`)}</p> : null}
        {row.nextAttemptAt ? <p>{t("nextAttempt", { time: format.dateTime(new Date(row.nextAttemptAt), { dateStyle: "medium", timeStyle: "short" }) })}</p> : null}
      </li>)}</ul>}
      {state.nextCursor ? <button type="button" className="secondary-button" disabled={pending || offline} onClick={() => {
        startTransition(async () => { try { const result = await pushSettingsAction({ cursor: state.nextCursor });
          if (result.ok) setState((old) => ({ ...result.data, items: [...(old?.items ?? []), ...result.data.items.filter((row) => !old?.items.some((item) => item.id === row.id))] })); else setError(true);
        } catch { setError(true); } });
      }}>{t("more")}</button> : null}
    </> : null}
  </section>;
}
