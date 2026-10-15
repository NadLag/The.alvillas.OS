/* global self, fetch, URL */
self.addEventListener("install", (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id);
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try { payload = event.data?.json(); } catch { return; }
    if (!validId(payload?.deliveryId)) return;
    const path = `/api/notifications/push/${payload.deliveryId}`;
    // Payloads carry no record contents. An active, authorized session must resolve
    // the message before it can appear on a shared device's lock screen.
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const message = await response.json();
    await self.registration.showNotification(message.title, { body: message.body, lang: message.locale,
      tag: payload.deliveryId, renotify: false, data: { deliveryId: payload.deliveryId } });
    await fetch(path, { method: "POST", credentials: "same-origin", headers: { "x-alvillas-push-receipt": "1" } });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data?.deliveryId;
  if (!validId(id)) return;
  event.waitUntil((async () => {
    const url = new URL(`/api/notifications/push/${id}/open`, self.location.origin).href;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = clients.find((item) => new URL(item.url).origin === self.location.origin);
    if (client) { await client.navigate(url); await client.focus(); }
    else await self.clients.openWindow(url);
  })());
});
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "alvillas-push-subscription-changed" });
  })());
});
