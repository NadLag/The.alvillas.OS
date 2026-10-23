/// <reference lib="webworker" />

const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/u.test(value);
function deliveryId(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("deliveryId" in value) || !validId(value.deliveryId)) return null;
  return value.deliveryId;
}

export function installNotificationWorker(scope: ServiceWorkerGlobalScope): void {
  scope.addEventListener("push", event => {
    event.waitUntil((async () => {
      let payload: unknown;
      try { payload = event.data?.json() as unknown; } catch { return; }
      const id = deliveryId(payload);
      if (!id) return;
      const path = `/api/notifications/push/${id}`;
      // Notification contents still require an active, authorized server session.
      const response = await fetch(path, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) return;
      const message: unknown = await response.json();
      if (!message || typeof message !== "object" || !("title" in message) || typeof message.title !== "string" ||
        !("body" in message) || typeof message.body !== "string" || !("locale" in message) || typeof message.locale !== "string") return;
      await scope.registration.showNotification(message.title, { body: message.body, lang: message.locale,
        tag: id, data: { deliveryId: id } });
      await fetch(path, { method: "POST", credentials: "same-origin", headers: { "x-alvillas-push-receipt": "1" } });
    })());
  });
  scope.addEventListener("notificationclick", event => {
    event.notification.close();
    const id = deliveryId(event.notification.data as unknown);
    if (!id) return;
    event.waitUntil((async () => {
      const url = new URL(`/api/notifications/push/${id}/open`, scope.location.origin).href;
      const clients = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = clients.find(item => new URL(item.url).origin === scope.location.origin);
      if (client) { await client.navigate(url); await client.focus(); }
      else await scope.clients.openWindow(url);
    })());
  });
  scope.addEventListener("pushsubscriptionchange", event => {
    event.waitUntil((async () => {
      for (const client of await scope.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        client.postMessage({ type: "alvillas-push-subscription-changed" });
      }
    })());
  });
}
