"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { FieldQueueScope } from "./field-queue-store";
import { refreshFieldApp } from "./field-update";

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function FieldPwa({ organizationId, userId }: FieldQueueScope) {
  const t = useTranslations("FieldPwa");
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [offline, setOffline] = useState(false);
  const [update, setUpdate] = useState(false);
  const [pending, setPending] = useState(0);
  const [failures, setFailures] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<"installHelp" | "iosHelp" | "saveBeforeUpdate" | "unavailable" | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);
  const retrySync = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    let hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);
    let checkedAt = 0;
    const scope = { organizationId, userId };
    const network = () => setOffline(!navigator.onLine);
    const ready = (async () => {
      const [{ fieldQueue }, { liveQuery }] = await Promise.all([import("./field-queue"), import("dexie")]);
      const queue = fieldQueue();
      await queue.activate(scope);
      await queue.migrateLegacy(scope, localStorage);
      if (disposed) return queue;
      subscription = liveQuery(() => queue.entries(scope)).subscribe({ next: entries => {
        setPending(entries.filter(entry => entry.syncStatus === "pending").length);
        setFailures(entries.filter(entry => entry.syncStatus !== "pending").length);
      }, error: () => setNotice("unavailable") });
      return queue;
    })();
    const sync = async () => {
      try {
        const queue = await ready;
        if (disposed || !navigator.onLine) return;
        setSyncing(true);
        const { syncFieldQueue } = await import("./field-sync");
        await syncFieldQueue(queue, scope);
      } catch { if (!disposed) setNotice("unavailable"); }
      finally { if (!disposed) setSyncing(false); }
    };
    retrySync.current = () => { void sync(); };
    const checkUpdate = async () => {
      if (!navigator.onLine || Date.now() - checkedAt < 60_000) return;
      checkedAt = Date.now();
      try { await registration.current?.update(); } catch { /* A lost connection never blocks field work. */ }
    };
    const online = () => { network(); void sync(); void checkUpdate(); };
    const installAvailable = (event: Event) => { event.preventDefault(); setInstall(event as InstallEvent); };
    const installationFinished = () => { setInstalled(true); setInstall(null); setNotice(null); };
    const controllerChanged = () => {
      if (hadController) setUpdate(true);
      hadController = true;
    };
    const workerMessage = () => { void sync(); };
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
    return () => {
      disposed = true; subscription?.unsubscribe();
      retrySync.current = () => undefined;
      window.removeEventListener("online", online); window.removeEventListener("offline", network); window.removeEventListener("focus", online);
      window.removeEventListener("beforeinstallprompt", installAvailable); window.removeEventListener("appinstalled", installationFinished);
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
    });
  }

  return <aside className="field-pwa-tools" aria-label={t("tools")} data-testid="field-pwa">
    <div className="form-actions">
      {installed ? <span>{t("installed")}</span> : <button className="secondary-button" type="button" data-testid="field-install" onClick={() => { void installApp(); }}>{t("install")}</button>}
      {update ? <button className="secondary-button" type="button" data-testid="field-update" disabled={offline} onClick={updateApp}>{t("update")}</button> : null}
      {pending ? <button className="secondary-button" type="button" data-testid="field-sync-now" disabled={offline || syncing} onClick={() => retrySync.current()}>{t("syncNow")}</button> : null}
    </div>
    <p role="status" data-testid="field-connection">{t(offline ? "offline" : "online")}{pending ? ` · ${t("pending", { count: pending })}` : ""}{failures ? ` · ${t("failures", { count: failures })}` : ""}</p>
    {notice ? <p role="status" data-testid="field-pwa-notice">{t(notice)}</p> : null}
  </aside>;
}
