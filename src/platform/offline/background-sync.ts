type BackgroundRegistration = ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } };

export async function requestFieldBackgroundSync(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registration: BackgroundRegistration | undefined = await navigator.serviceWorker.getRegistration();
    await registration?.sync?.register("alvillas-field-queue");
  } catch { /* Online/focus sync remains available when background sync is unsupported. */ }
}
