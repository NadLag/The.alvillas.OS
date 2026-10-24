export function refreshFieldApp(registration: ServiceWorkerRegistration | null, reload: () => void, unavailable: () => void): void {
  const waiting = registration?.waiting;
  const initialWorker = waiting ?? registration?.active;
  if (!initialWorker) { reload(); return; }
  let worker: ServiceWorker = initialWorker;
  const container = navigator.serviceWorker;
  if (!waiting && worker.state === "activated" && container.controller === worker) { reload(); return; }
  const channel = new MessageChannel();
  let refreshed = false;
  let poll: number | undefined;
  let requestedAt = Date.now();
  const ready = () => worker.state === "activated" && container.controller === worker;
  const finish = (activated: boolean) => {
    if (refreshed) return;
    refreshed = true;
    window.clearTimeout(timeout); window.clearTimeout(poll); channel.port1.close(); worker.removeEventListener("statechange", changed);
    container.removeEventListener("controllerchange", changed);
    if (activated) reload(); else unavailable();
  };
  const changed = () => {
    if (refreshed) return;
    if (worker.state === "redundant") { finish(false); return; }
    window.clearTimeout(poll);
    // Check on a new task after browser lifecycle notifications have settled.
    poll = window.setTimeout(inspect, 0);
  };
  const inspect = () => {
    if (refreshed) return;
    // Another registration/update can replace the waiting slot while this
    // document stays open. Only the current replacement may authorize reload.
    const replacement = registration?.waiting;
    if (replacement && replacement !== worker) {
      worker.removeEventListener("statechange", changed);
      worker = replacement;
      worker.addEventListener("statechange", changed);
      requestedAt = Number.NEGATIVE_INFINITY;
    }
    if (ready()) { finish(true); return; }
    if (worker.state === "redundant") { finish(false); return; }
    // A stopped worker can miss the initial wake-up. skipWaiting is idempotent;
    // resend within the existing deadline without reusing a transferred port.
    if (registration?.waiting === worker && worker.state === "installed" && Date.now() - requestedAt >= 250) {
      requestedAt = Date.now();
      try { worker.postMessage({ type: "ALVILLAS_SKIP_WAITING" }); }
      catch { finish(false); return; }
      if (ready()) { finish(true); return; }
    }
    poll = window.setTimeout(inspect, 50);
  };
  // The waiting slot clears while the replacement is still activating. Neither
  // that empty slot nor an acknowledgement proves this document is controlled.
  const timeout = window.setTimeout(() => finish(ready()), 3000);
  worker.addEventListener("statechange", changed);
  container.addEventListener("controllerchange", changed);
  channel.port1.onmessage = event => {
    const value: unknown = event.data;
    if (value && typeof value === "object" && "type" in value && value.type === "ALVILLAS_UPDATE_READY") changed();
  };
  poll = window.setTimeout(inspect, 0);
  try { waiting?.postMessage({ type: "ALVILLAS_SKIP_WAITING" }, [channel.port2]); }
  catch { finish(false); }
}
