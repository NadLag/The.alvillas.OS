"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { FieldCacheAudience, FieldQueueEntry, FieldQueueScope } from "./field-queue-store";
import type { FieldWorkSnapshot } from "@/modules/reservations/domain/field-pull";
import { fieldQueueAge, type FieldQueueAge } from "./field-queue-age";
import { refreshFieldApp, settleFieldForegroundWork } from "./field-update";
import { liveQuery } from "dexie";
import { fieldQueue } from "./field-queue";
import { resolveFieldScope } from "./field-session";
import { syncFieldQueue } from "./field-sync";
import { refreshFieldCache } from "./field-pull";

type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

export function FieldPwa({ organizationId, userId, audience = "assigned" }: FieldQueueScope & { audience?: FieldCacheAudience }) {
  const t = useTranslations("FieldPwa");
  const cacheText = useTranslations("FieldCache");
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [offline, setOffline] = useState(false);
  const [update, setUpdate] = useState(false);
  const [pending, setPending] = useState(0);
  const [failures, setFailures] = useState(0);
  const [queueAge, setQueueAge] = useState<FieldQueueAge>({ count: 0, oldestMinutes: 0, nextCheckAfterMs: null });
  const [syncing, setSyncing] = useState(false);
  const [cached, setCached] = useState<number | null>(null);
  const [cacheFailed, setCacheFailed] = useState(false);
  const [notice, setNotice] = useState<"installHelp" | "iosHelp" | "saveBeforeUpdate" | "unavailable" | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);
  const updateEpoch = useRef(0);
  const foregroundWork = useRef(new Set<Promise<void>>());
  const syncAfterUpdate = useRef(false);
  const retrySync = useRef<() => void>(() => undefined);

  useEffect(() => {
    const epoch = updateEpoch.current;
    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;
    let cacheSubscription: { unsubscribe(): void } | undefined;
    let hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);
    let checkedAt = 0;
    let photoRetry: ReturnType<typeof setTimeout> | undefined;
    let ageTimer: ReturnType<typeof setTimeout> | undefined;
    let queueSnapshot: { entries: FieldQueueEntry[]; tasks: FieldWorkSnapshot[] } = { entries: [], tasks: [] };
    const scope = { organizationId, userId };
    const network = () => setOffline(!navigator.onLine);
    const refreshAge = () => {
      if (ageTimer) clearTimeout(ageTimer);
      if (disposed) return;
      const value = fieldQueueAge(scope, queueSnapshot.entries, queueSnapshot.tasks, Date.now());
      setQueueAge(value);
      if (value.nextCheckAfterMs !== null) ageTimer = setTimeout(refreshAge, Math.min(value.nextCheckAfterMs, 2_147_483_647));
    };
    const ready = (async () => {
      const queue = fieldQueue();
      if (!await resolveFieldScope(queue, navigator.onLine, scope)) throw new Error("FIELD_SESSION_CHANGED");
      await queue.migrateLegacy(scope, localStorage);
      if (disposed) return queue;
      subscription = liveQuery(async () => {
        const [entries, assigned, supervised] = await Promise.all([queue.entries(scope), queue.readCache(scope), queue.readCache(scope, "supervised")]);
        return { entries, tasks: [...assigned.tasks, ...supervised.tasks] };
      }).subscribe({ next: value => {
        const { entries } = value; queueSnapshot = value;
        setPending(entries.filter(entry => entry.syncStatus === "pending").length);
        setFailures(entries.filter(entry => entry.syncStatus !== "pending" && !entry.resolvedByClientOpId).length);
        refreshAge();
      }, error: () => { queueSnapshot = { entries: [], tasks: [] }; refreshAge(); setNotice("unavailable"); } });
      cacheSubscription = liveQuery(() => queue.readCache(scope, audience)).subscribe({ next: value => {
        if (value.state?.snapshotAt) setCached(value.tasks.length);
        else if (value.state?.invalidated) setCached(null);
      }, error: () => setCached(null) });
      return queue;
    })();
    const performSync = async (afterCurrent = false) => {
      try {
        const queue = await ready;
        if (disposed || !navigator.onLine || updateRequested.current) return;
        setSyncing(true);
        const outcome = await syncFieldQueue(queue, scope);
        if (photoRetry) clearTimeout(photoRetry);
        if (!disposed && outcome === "queued") {
          const next = (await queue.entries(scope)).find(entry => entry.syncStatus === "pending");
          const photo = next && await queue.photos.get(`${organizationId}:${userId}:${next.operation.client_op_id}`);
          if (!disposed && photo && !photo.ready && photo.retryAt > 0) photoRetry = setTimeout(() => { void sync(); }, Math.max(0, photo.retryAt - Date.now()));
        }
        // The initial/timer drain may finish after explicit promotion started.
        // Do not restart the exiting worker with a redundant automatic pull.
        // Foreground online/focus and manual synchronization still opt in.
        if (disposed || updateRequested.current || (!afterCurrent && registration.current?.waiting)) return;
        try {
          await refreshFieldCache(queue, scope, fetch, { afterCurrent, audience });
          if (!disposed) { setCacheFailed(false); window.dispatchEvent(new Event("alvillas-field-cache-ready")); }
        } catch { if (!disposed) setCacheFailed(true); }
      } catch { if (!disposed) setNotice("unavailable"); }
      finally { if (!disposed) setSyncing(false); }
    };
    const sync = (afterCurrent = false) => {
      if (updateRequested.current) { syncAfterUpdate.current = true; return Promise.resolve(); }
      const pending = performSync(afterCurrent); foregroundWork.current.add(pending);
      void pending.finally(() => foregroundWork.current.delete(pending));
      return pending;
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
      const path = location.pathname.match(/^\/(en|fr|ar)\/(?:app\/field(?:\/(validate))?(?:\/([a-f0-9-]{36}))?|offline\/field)$/u);
      const currentTask = path?.[3] ?? new URLSearchParams(location.search).get("task");
      if (path && currentTask === value.taskId) location.assign(`/${path[1]}/app/field${audience === "supervised" ? "/validate" : ""}`);
    };
    const acknowledgedHere = (event: Event) => acknowledged((event as CustomEvent<unknown>).detail);
    const workerMessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (data.type === "alvillas-field-acknowledged") { if ("detail" in data) acknowledged(data.detail); return; }
      // The native acknowledgement already updates the queue and live cache.
      // A new pull while promotion is pending can restart the exiting worker.
      if (data.type === "alvillas-field-sync-finished" && !registration.current?.waiting) void sync();
    };
    const offlineNavigation = (event: MouseEvent) => {
      if (navigator.onLine || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor || anchor.closest('[data-testid="field-language"]')) return;
      const url = new URL(anchor.href), match = url.pathname.match(/^\/(en|fr|ar)\/app\/field(?:\/(validate))?(?:\/([a-f0-9-]{36}))?$/u);
      if (url.origin !== location.origin || !match) return;
      event.preventDefault(); event.stopPropagation();
      const query = new URLSearchParams(); if (match[2]) query.set("view", "supervised"); if (match[3]) query.set("task", match[3]);
      window.location.assign(`/${match[1]}/offline/field${query.size ? `?${query}` : ""}`);
    };
    queueMicrotask(() => {
      if (disposed) return;
      network();
      refreshAge();
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
      updateEpoch.current = epoch + 1; updateRequested.current = false; syncAfterUpdate.current = false;
      disposed = true; subscription?.unsubscribe(); cacheSubscription?.unsubscribe();
      if (photoRetry) clearTimeout(photoRetry);
      if (ageTimer) clearTimeout(ageTimer);
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
  }, [organizationId, userId, audience]);

  async function installApp() {
    if (!install) { setNotice(ios ? "iosHelp" : "installHelp"); return; }
    try { await install.prompt(); await install.userChoice; setInstall(null); }
    catch { setNotice("installHelp"); }
  }
  function updateApp() {
    if (!navigator.onLine) return;
    if (document.querySelector('[data-field-dirty="true"], [data-field-photo-dirty="true"]')) { setNotice("saveBeforeUpdate"); return; }
    if (updateRequested.current) return;
    updateRequested.current = true;
    const epoch = updateEpoch.current;
    const resume = () => {
      updateRequested.current = false;
      if (syncAfterUpdate.current) { syncAfterUpdate.current = false; retrySync.current(); }
    };
    const unavailable = () => {
      if (updateEpoch.current !== epoch) return;
      resume(); setNotice("unavailable");
    };
    void settleFieldForegroundWork(foregroundWork.current).then(settled => {
      if (updateEpoch.current !== epoch) return;
      if (!settled) { unavailable(); return; }
      const reload = () => {
        if (updateEpoch.current !== epoch) return;
        if (!navigator.onLine) { resume(); setOffline(true); return; }
        if (document.querySelector('[data-field-dirty="true"], [data-field-photo-dirty="true"]')) { resume(); setNotice("saveBeforeUpdate"); return; }
        window.location.reload();
      };
      if (!navigator.onLine) { resume(); setOffline(true); return; }
      if (document.querySelector('[data-field-dirty="true"], [data-field-photo-dirty="true"]')) { resume(); setNotice("saveBeforeUpdate"); return; }
      refreshFieldApp(registration.current, reload, unavailable);
    }).catch(unavailable);
  }

  return <aside className="field-pwa-tools" aria-label={t("tools")} data-testid="field-pwa">
    <div className="form-actions">
      {installed ? <span>{t("installed")}</span> : <button className="secondary-button" type="button" data-testid="field-install" onClick={() => { void installApp(); }}>{t("install")}</button>}
      {update ? <button className="secondary-button" type="button" data-testid="field-update" disabled={offline} onClick={updateApp}>{t("update")}</button> : null}
      <button className="secondary-button" type="button" data-testid="field-sync-now" disabled={offline || syncing} onClick={() => retrySync.current()}>{t("syncNow")}</button>
    </div>
    <p role="status" data-testid="field-connection">{t(offline ? "offline" : "online")}{pending ? ` · ${t("pending", { count: pending })}` : ""}{failures ? ` · ${t("failures", { count: failures })}` : ""}</p>
    <p role="status" data-testid="field-cache-status">{cacheFailed ? cacheText("retry") : cached !== null ? cacheText("ready", { count: cached }) : cacheText(offline ? "notPrepared" : "preparing")}</p>
    {queueAge.count ? <p role="status" data-testid="field-queue-age-warning">{t("queueAgeWarning", { count: queueAge.count, minutes: queueAge.oldestMinutes })}</p> : null}
    {notice ? <p role="status" data-testid="field-pwa-notice">{t(notice)}</p> : null}
  </aside>;
}
