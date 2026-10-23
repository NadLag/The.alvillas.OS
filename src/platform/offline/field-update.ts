export function refreshFieldApp(registration: ServiceWorkerRegistration | null, reload: () => void): void {
  const waiting = registration?.waiting;
  if (!waiting) { reload(); return; }
  const channel = new MessageChannel();
  let refreshed = false;
  const refresh = () => {
    if (refreshed) return;
    refreshed = true;
    window.clearTimeout(timeout); channel.port1.close(); reload();
  };
  // Authenticated HTML always comes from the network and assets use content hashes.
  // A missing worker notification must not leave an explicit refresh waiting forever.
  const timeout = window.setTimeout(refresh, 3000);
  channel.port1.onmessage = event => {
    const value: unknown = event.data;
    if (value && typeof value === "object" && "type" in value && value.type === "ALVILLAS_UPDATE_READY") refresh();
  };
  try { waiting.postMessage({ type: "ALVILLAS_SKIP_WAITING" }, [channel.port2]); }
  catch { refresh(); }
}
