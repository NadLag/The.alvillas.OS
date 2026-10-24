/// <reference lib="webworker" />

import { installNotificationWorker } from "@/platform/notifications/service-worker";
import { FieldQueueStore } from "./field-queue-store";
import { syncFieldQueue } from "./field-sync";

declare const self: ServiceWorkerGlobalScope & { ALVILLAS_RELEASE: string };
const prefix = "alvillas-public-assets-";
const cacheName = prefix + self.ALVILLAS_RELEASE;
installNotificationWorker(self);
const offlineShell = /^\/(en|fr|ar)\/offline\/field$/u;

async function prepareOfflineShells() {
  const cache = await caches.open(cacheName), assets = new Map<string, Promise<void>>();
  const download = (url: URL): Promise<void> => {
    const existing = assets.get(url.href); if (existing) return existing;
    const pending = (async () => {
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) throw new Error("Offline public asset unavailable");
      await cache.put(url, response.clone());
      if (url.pathname.endsWith(".css")) {
        const css = await response.text();
        const fonts = [...css.matchAll(/url\(["']?([^\s)'"\n]+)["']?\)/gu)].map(match => new URL(match[1], url));
        await Promise.all(fonts.filter(asset => asset.origin === self.location.origin && asset.pathname.startsWith("/_next/static/")).map(download));
      }
    })(); assets.set(url.href, pending); return pending;
  };
  await Promise.all(["en", "fr", "ar"].map(async locale => {
    const url = new URL(`/${locale}/offline/field`, self.location.origin), response = await fetch(url, { credentials: "omit" });
    if (!response.ok || response.redirected) throw new Error("Offline public shell unavailable");
    const html = await response.clone().text();
    if (!html.includes('data-field-offline-shell="public"')) throw new Error("Offline public shell marker missing");
    const links = [...html.matchAll(/(?:src|href)="([^"<>]+)"/gu)].map(match => new URL(match[1].replaceAll("&amp;", "&"), url));
    await Promise.all(links.filter(asset => asset.origin === self.location.origin && asset.pathname.startsWith("/_next/static/")).map(download));
    // Publish HTML only after every referenced public asset is durable.
    await cache.put(url, response);
  }));
}
self.addEventListener("install", event => { event.waitUntil(prepareOfflineShells()); });

// An update waits for the user's explicit refresh; queued work remains in IndexedDB.
self.addEventListener("message", event => {
  const data: unknown = event.data;
  if (data && typeof data === "object" && "type" in data && data.type === "ALVILLAS_SKIP_WAITING") {
    // The request persists in the browser independently of this message event.
    // Its promise can remain pending until activation; do not hold this event
    // open across that lifecycle transition. The page still requires actual
    // controller adoption before it reloads.
    void self.skipWaiting().then(() => { event.ports[0]?.postMessage({ type: "ALVILLAS_UPDATE_READY" }); }).catch(() => undefined);
  }
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    await caches.open(cacheName);
    const previous = (await caches.keys()).filter(key => key.startsWith(prefix) && key !== cacheName);
    await Promise.all(previous.slice(0, -1).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method === "GET" && url.origin === self.location.origin && event.request.mode === "navigate") {
    const field = url.pathname.match(/^\/(en|fr|ar)\/app\/field(?:\/([a-f0-9-]{36}))?$/u);
    if (field || offlineShell.test(url.pathname)) {
      event.respondWith((async () => {
        try { return await fetch(event.request); }
        catch (error) {
          if (field) return Response.redirect(new URL(`/${field[1]}/offline/field${field[2] ? `?task=${field[2]}` : ""}`, url), 302);
          const normalized = new URL(url.pathname, url.origin);
          const cached = await (await caches.open(cacheName)).match(normalized);
          if (cached) return cached;
          throw error;
        }
      })()); return;
    }
  }
  // Only static assets and the anonymous public shell enter CacheStorage.
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/_next/static/")) return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      try { await (await caches.open(cacheName)).put(event.request, response.clone()); } catch { /* Work can continue when public asset caching is unavailable. */ }
    }
    return response;
  })());
});
self.addEventListener("sync", event => {
  const sync = event as ExtendableEvent & { tag: string };
  if (sync.tag !== "alvillas-field-queue") return;
  sync.waitUntil((async () => {
    const queue = new FieldQueueStore();
    const identity = await queue.metadata.get("identity");
    if (!identity) return;
    const [organizationId, userId] = identity.value.split(":");
    if (!organizationId || !userId) return;
    const result = await syncFieldQueue(queue, { organizationId, userId }, fetch, async detail => {
      for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        client.postMessage({ type: "alvillas-field-acknowledged", detail });
      }
    });
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      client.postMessage({ type: "alvillas-field-sync-finished", result });
    }
    if (result === "queued") throw new Error("Field sync transport remains unavailable");
  })());
});
