/// <reference lib="webworker" />

import { installNotificationWorker } from "@/platform/notifications/service-worker";
import { FieldQueueStore } from "./field-queue-store";
import { syncFieldQueue } from "./field-sync";

declare const self: ServiceWorkerGlobalScope & { ALVILLAS_RELEASE: string };
const prefix = "alvillas-public-assets-";
const cacheName = prefix + self.ALVILLAS_RELEASE;
installNotificationWorker(self);

// An update waits for the user's explicit refresh; queued work remains in IndexedDB.
self.addEventListener("message", event => {
  const data: unknown = event.data;
  if (data && typeof data === "object" && "type" in data && data.type === "ALVILLAS_SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
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
  // Authenticated HTML, API responses and business records never enter CacheStorage.
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
