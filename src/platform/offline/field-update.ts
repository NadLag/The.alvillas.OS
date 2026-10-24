export function refreshFieldApp(registration: ServiceWorkerRegistration | null, reload: () => void, unavailable: () => void): void {
  const waiting = registration?.waiting;
  if (!waiting) { reload(); return; }
  const channel = new MessageChannel();
  let refreshed = false;
  const finish = (activated: boolean) => {
    if (refreshed) return;
    refreshed = true;
    window.clearTimeout(timeout); channel.port1.close(); waiting.removeEventListener("statechange", changed);
    if (activated) reload(); else unavailable();
  };
  const changed = () => {
    if (waiting.state === "activated") finish(true);
    else if (waiting.state === "redundant") finish(false);
  };
  // skipWaiting's acknowledgement can precede activation. Navigating while the
  // replacement is activating can strand a native browser's document load.
  // Polling also recovers a missed message/state event without blind reloads.
  const timeout = window.setTimeout(() => finish(waiting.state === "activated"), 3000);
  waiting.addEventListener("statechange", changed);
  channel.port1.onmessage = event => {
    const value: unknown = event.data;
    if (value && typeof value === "object" && "type" in value && value.type === "ALVILLAS_UPDATE_READY") changed();
  };
  try { waiting.postMessage({ type: "ALVILLAS_SKIP_WAITING" }, [channel.port2]); }
  catch { finish(false); }
}
