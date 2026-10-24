export function refreshFieldApp(registration: ServiceWorkerRegistration | null, reload: () => void, unavailable: () => void): void {
  const waiting = registration?.waiting;
  const worker = waiting ?? registration?.active;
  if (!worker) { reload(); return; }
  const container = navigator.serviceWorker;
  if (!waiting && worker.state === "activated" && container.controller === worker) { reload(); return; }
  const channel = new MessageChannel();
  let refreshed = false;
  let poll: number | undefined;
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
    if (ready()) { finish(true); return; }
    if (worker.state === "redundant") { finish(false); return; }
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
