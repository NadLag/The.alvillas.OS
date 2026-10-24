import { expect, type Page } from "@playwright/test";
import webpush from "web-push";

// Browser-vendor subscription/transport is isolated in tests. Service-worker
// registration, notification display, click routing, auth and PostgreSQL are real.
export async function installTestPushSubscription(page: Page, token: string) {
  const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, expirationTime: null,
    keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.alloc(16, 9).toString("base64url") } };
  await page.context().grantPermissions(["notifications"], { origin: "http://127.0.0.1:3000" });
  await page.addInitScript((value) => {
    let active = localStorage.getItem("test-push-active") === "yes";
    const create = () => ({ ...value, toJSON: () => value, unsubscribe: () => { active = false; localStorage.removeItem("test-push-active"); return Promise.resolve(true); } });
    Object.defineProperty(PushManager.prototype, "subscribe", { configurable: true, value: () => { active = true; localStorage.setItem("test-push-active", "yes"); return Promise.resolve(create()); } });
    Object.defineProperty(PushManager.prototype, "getSubscription", { configurable: true, value: () => Promise.resolve(active ? create() : null) });
  }, subscription);
}
export async function displayAndClickPush(page: Page, deliveryId: string) {
  const client = await page.context().newCDPSession(page);
  let registrationId: string | undefined;
  client.on("ServiceWorker.workerRegistrationUpdated", (event) => { registrationId = event.registrations.find((row) => row.scopeURL === "http://127.0.0.1:3000/" && !row.isDeleted)?.registrationId ?? registrationId; });
  await client.send("ServiceWorker.enable");
  await expect.poll(() => registrationId).toBeTruthy();
  const worker = page.context().serviceWorkers().find((item) => item.url().endsWith("/sw.js"))!;
  await worker.evaluate("self.addEventListener('unhandledrejection', event => { self.testPushError = event.reason?.message ?? String(event.reason); }); self.addEventListener('push', event => { self.testPushText = event.data?.text(); });");
  await worker.evaluate(`(() => {
    self.testPushRequests = []; self.testPushWork = [];
    const nativePushFetch = self.fetch.bind(self), nativeWaitUntil = ExtendableEvent.prototype.waitUntil;
    self.fetch = async (...args) => {
      const response = await nativePushFetch(...args); const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, self.location.origin);
      if (url.pathname.startsWith('/api/notifications/push/')) self.testPushRequests.push({ method: args[1]?.method ?? 'GET', status: response.status }); return response;
    };
    ExtendableEvent.prototype.waitUntil = function(work) {
      const result = Reflect.apply(nativeWaitUntil, this, [work]);
      if (this.type === 'push') self.testPushWork.push(Promise.resolve(work)); return result;
    };
  })();`);
  await client.send("ServiceWorker.deliverPushMessage", { origin: "http://127.0.0.1:3000", registrationId: registrationId!, data: JSON.stringify({ deliveryId }) });
  await expect.poll(() => worker.evaluate("({text:self.testPushText,error:self.testPushError})")).toEqual({ text: JSON.stringify({ deliveryId }), error: undefined });
  await expect.poll(() => worker.evaluate("self.testPushWork.length")).toBeGreaterThan(0);
  await worker.evaluate("Promise.all(self.testPushWork)");
  expect(await worker.evaluate("self.testPushRequests")).toContainEqual({ method: "GET", status: 200 });
  try { await expect.poll(() => worker.evaluate("self.registration.getNotifications().then(items => items.length)")).toBe(1); }
  catch (error) {
    console.log(JSON.stringify({ nativePushFailure: await worker.evaluate("({ requests: self.testPushRequests, error: self.testPushError, state: self.serviceWorker?.state })") }));
    throw error;
  }
  const notifications = await worker.evaluate<Array<{ tag: string; title: string }>>("self.registration.getNotifications().then(items => items.map(item => ({ tag: item.tag, title: item.title })))");
  expect(notifications[0].tag).toBe(deliveryId);
  await client.detach();
  // Detach before navigation: Chrome may otherwise wait indefinitely for the
  // page's in-flight DevTools session while clients.navigate changes its target.
  await worker.evaluate("self.registration.getNotifications().then(items => { self.dispatchEvent(new NotificationEvent('notificationclick', { notification: items[0] })); })");
}
