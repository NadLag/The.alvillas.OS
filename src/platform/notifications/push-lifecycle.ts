"use client";

import { useEffect } from "react";
import { pushRevokeAction, pushSettingsAction, pushSubscribeAction } from "./notification-actions";

export function pushSupported() {
  return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
export async function browserPushPermission(): Promise<NotificationPermission> {
  try { const result = await navigator.permissions.query({ name: "notifications" }); return result.state === "prompt" ? "default" : result.state; }
  catch { return Notification.permission; }
}
export function usePushLifecycle() {
  useEffect(() => {
    if (!pushSupported()) return;
    let running = false;
    const sync = async () => {
      if (running || !navigator.onLine || document.visibilityState !== "visible") return;
      running = true;
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (await browserPushPermission() !== "granted" || !subscription) {
          await pushRevokeAction({ id: null, reason: "permission_revoked" });
        } else {
          const state = await pushSettingsAction();
          if (state.ok && state.data.subscriptions.some((row) => row.currentSession)) await pushSubscribeAction(subscription.toJSON());
        }
      } catch { /* Reconcile on the next online/focus event. Never prompt automatically. */ }
      finally { running = false; }
    };
    const schedule = () => { void sync(); };
    schedule();
    window.addEventListener("online", schedule); window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule); navigator.serviceWorker.addEventListener("message", schedule);
    let permission: PermissionStatus | undefined;
    void navigator.permissions?.query({ name: "notifications" }).then((value) => { permission = value; value.addEventListener("change", schedule); }).catch(() => {});
    return () => { window.removeEventListener("online", schedule); window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule); navigator.serviceWorker.removeEventListener("message", schedule); permission?.removeEventListener("change", schedule); };
  }, []);
}
