"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { FieldQueueScope } from "./field-queue-store";
import { refreshFieldApp } from "./field-update";
import { liveQuery } from "dexie";
import { fieldQueue } from "./field-queue";
import { resolveFieldScope } from "./field-session";
import { syncFieldQueue } from "./field-sync";
import { refreshFieldCache } from "./field-pull";

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function FieldPwa({ organizationId, userId }: FieldQueueScope) {
  const t = useTranslations("FieldPwa");
  const cacheText = useTranslations("FieldCache");
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [offline, setOffline] = useState(false);
  const [update, setUpdate] = useState(false);
  const [pending, setPending] = useState(0);
  const [failures, setFailures] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [cached, setCached] = useState<number | null>(null);
  const [cacheFailed, setCacheFailed] = useState(false);
  const [notice, setNotice] = useState<"installHelp" | "iosHelp" | "saveBeforeUpdate" | "unavailable" | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);
  const retrySync = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    let cacheSubscription: { unsubscribe(): void } | undefined;
    let hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);
    let checkedAt = 0;
    const scope = { organizationId, userId };
    const network = () => setOffline(!navigator.onLine);
    const ready = (async () => {
      const queue = fieldQueue();
      if (!await resolveFieldScope(queue, navigator.onLine, scope)) throw new Error("FIELD_SESSION_CHANGED");
      await queue.migrateLegacy(scope, localStorage);
      if (disposed) return queue;
      subscription = liveQuery(() => queue.entries(scope)).subscribe({ next: entries => {
        setPending(entries.filter(entry => entry.syncStatus === "pending").length);
        setFailures(entries.filter(entry => entry.syncStatus !== "pending").length);
      }, error: () => setNotice("unavailable") });
      cacheSubscription = liveQuery(() => queue.readCache(scope)).subscribe({ next: value => {
        if (value.state?.snapshotAt) setCached(value.tasks.length);
        else if (value.state?.invalidated) setCached(null);
      }, error: () => setCached(null) });
      return queue;
    })();
    const sync = async (afterCurrent = false) => {
      try {
        const queue = await ready;
        if (disposed || !navigator.onLine) return;
        setSyncing(true);
        await syncFieldQueue(queue, scope);
        try {
          await refreshFieldCache(queue, scope, fetch, { afterCurrent });
          if (!disposed) { setCacheFailed(false); window.dispatchEvent(new Event("alvillas-field-cache-ready")); }
        } catch { if (!disposed) setCacheFailed(true); }
      } catch { if (!disposed) setNotice("unavailable"); }
      finally { if (!disposed) setSyncing(false); }
    };
    retrySync.current = () => { void sync(true); };
    const checkUpdate = async () => {
      if (!navigator.onLine || Date.now() - checkedAt < 60_000) return;
      checkedAt = Date.now();
      try { await registration.current?.update(); } catch { /* A lost connection never blocks field work. */ }
    };
    const online = () => { network(); void sync(true); void checkUpdate(); };
    const installAvailable = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    const installationFinished = () => { setInstalled(true); setInstall(null); setNotice(null); };
    const controllerChanged = () => {
      if (hadController) setUpdate(true);
      hadController = true;
    };
    const acknowledged = (value: unknown) => {
      if (disposed || !value || typeof value !== "object" || !("organizationId" in value) || value.organizationId !== organizationId ||
        !("userId" in value) || value.userId !== userId || !("taskId" in value)) return;
      const path = location.pathname.match(/^\/(en|fr|ar)\/(?:app\/field(?:\/([a-f0-9-]{36}))?|offline\/field)$/u);
      const currentTask = path?.[2] ?? new URLSearchParams(location.search).get("task");
      if (path && currentTask === value.taskId) location.assign(`/${path[1]}/app/field`);
    };
    const acknowledgedHere = (event: Event) => acknowledged((event as CustomEvent<unknown>).detail);
    const workerMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (data && typeof data === "object" && "type" in data && data.type === "alvillas-field-acknowledged" && "detail" in data) acknowledged(data.detail);
      void sync();
    };
    const offlineNavigation = (event: MouseEvent) => {
      if (navigator.onLine || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor || anchor.closest('[data-testid="field-language"]')) return;
      const url = new URL(anchor.href), match = url.pathname.match(/^\/(en|fr|ar)\/app\/field(?:\/([a-f0-9-]{36}))?$/u);
      if (url.origin !== location.origin || !match) return;
      event.preventDefault(); event.stopPropagation();
      window.location.assign(`/${match[1]}/offline/field${match[2] ? `?task=${match[2]}` : ""}`);
    };
    queueMicrotask(() => {
      if (disposed) return;
      network();
      setInstalled(window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
      setIos(/iPad|iPhone|iPod/u.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
    });
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then(value => {
        if (disposed) return;
        registration.current = value;
        if (value.waiting) setUpdate(true);
        value.addEventListener("updatefound", () => {
          value.installing?.addEventListener("statechange", () => {
            if (!disposed && value.waiting && navigator.serviceWorker.controller) setUpdate(true);
          });
        });
      }).catch(() => { if (!disposed) setNotice("unavailable"); });
      navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);
      navigator.serviceWorker.addEventListener("message", workerMessage);
    }
    void sync();
    window.addEventListener("online", online); window.addEventListener("offline", network); window.addEventListener("focus", online);
    window.addEventListener("beforeinstallprompt", installAvailable); window.addEventListener("appinstalled", installationFinished);
    document.addEventListener("click", offlineNavigation, true);
    window.addEventListener("alvillas-field-acknowledged", acknowledgedHere);
    return () => {
      disposed = true; subscription?.unsubscribe(); cacheSubscription?.unsubscribe();
      retrySync.current = () => undefined;
      window.removeEventListener("online", online); window.removeEventListener("offline", network); window.removeEventListener("focus", online);
      window.removeEventListener("beforeinstallprompt", installAvailable); window.removeEventListener("appinstalled", installationFinished);
      document.removeEventListener("click", offlineNavigation, true);
      window.removeEventListener("alvillas-field-acknowledged", acknowledgedHere);
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
        navigator.serviceWorker.removeEventListener("message", workerMessage);
      }
    };
  }, [organizationId, userId]);

  async function installApp() {
    if (!install) { setNotice(ios ? "iosHelp" : "installHelp"); return; }
    try { await install.prompt(); await install.userChoice; setInstall(null); }
    catch { setNotice("installHelp"); }
  }
  function updateApp() {
    if (!navigator.onLine) return;
    if (document.querySelector('[data-field-dirty="true"]')) { setNotice("saveBeforeUpdate"); return; }
    if (updateRequested.current) return;
    updateRequested.current = true;
    refreshFieldApp(registration.current, () => {
      if (!navigator.onLine) { updateRequested.current = false; setOffline(true); return; }
      if (document.querySelector('[data-field-dirty="true"]')) { updateRequested.current = false; setNotice("saveBeforeUpdate"); return; }
      window.location.reload();
    }, () => {
      updateRequested.current = false; setNotice("unavailable");
    });
  }

  return <aside className="field-pwa-tools" aria-label={t("tools")} data-testid="field-pwa">
    <div className="form-actions">
      {installed ? <span>{t("installed")}</span> : <button className="secondary-button" type="button" data-testid="field-install" onClick={() => { void installApp(); }}>{t("install")}</button>}
      {update ? <button className="secondary-button" type="button" data-testid="field-update" disabled={offline} onClick={updateApp}>{t("update")}</button> : null}
      {pending || cacheFailed ? <button className="secondary-button" type="button" data-testid="field-sync-now" disabled={offline || syncing} onClick={() => retrySync.current()}>{t("syncNow")}</button> : null}
    </div>
    <p role="status" data-testid="field-connection">{t(offline ? "offline" : "online")}{pending ? ` · ${t("pending", { count: pending })}` : ""}{failures ? ` · ${t("failures", { count: failures })}` : ""}</p>
    <p role="status" data-testid="field-cache-status">{cacheFailed ? cacheText("retry") : cached !== null ? cacheText("ready", { count: cached }) : cacheText(offline ? "notPrepared" : "preparing")}</p>
    {notice ? <p role="status" data-testid="field-pwa-notice">{t(notice)}</p> : null}
  </aside>;
}
