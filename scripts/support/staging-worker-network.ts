import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// Fault injection includes native Background Sync fetches, which page routes miss.
// The dedicated browser exposes CDP only on loopback; never log its endpoint.
export async function blockStagingWorkerSync(profile: string, origin: string, options: { holdPhotoAfterFirstPart?: boolean } = {}) {
  if (origin !== "https://the-alvillas-os-staging.vercel.app") throw new Error("Dedicated staging browser required");
  const [port, path] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/u);
  if (!/^\d{1,5}$/u.test(port) || !/^\/devtools\/browser\/[a-f0-9-]+$/u.test(path)) throw new Error("Native browser endpoint required");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Native browser transport unavailable")); });
  let nextId = 0, configured = 0, blocked = 0, failure = false;
  let allUploads = false;
  const workerSessions = new Set<string>();
  const blockedURLs = () => [`${origin}/api/sync/push`, ...(allUploads ? [`${origin}/api/field/uploads*`] :
    options.holdPhotoAfterFirstPart ? [`${origin}/api/field/uploads/complete`, ...Array.from({ length: 63 }, (_, index) => `${origin}/api/field/uploads/part?*index=${index + 1}*`)] : [])];
  const pending = new Map<number, { resolve: () => void; reject: () => void; timeout: ReturnType<typeof setTimeout> }>();
  const configuring = new Set<Promise<void>>();
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<void>((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error("Native worker network control timed out")); }, 10000);
    pending.set(id, { resolve, reject: () => reject(new Error("Native worker network control failed")), timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.onmessage = event => {
    const value = z.object({ id: z.number().optional(), error: z.unknown().optional(), method: z.string().optional(), params: z.unknown().optional() }).parse(JSON.parse(String(event.data)));
    if (value.id !== undefined) {
      const entry = pending.get(value.id); if (!entry) return;
      pending.delete(value.id); clearTimeout(entry.timeout); if (value.error) entry.reject(); else entry.resolve();
    } else if (value.method === "Network.loadingFailed") {
      const result = z.object({ blockedReason: z.string().optional() }).parse(value.params);
      if (result.blockedReason === "inspector") blocked++;
    } else if (value.method === "Target.attachedToTarget") {
      const target = z.object({ sessionId: z.string(), targetInfo: z.object({ type: z.string(), url: z.string() }) }).parse(value.params);
      const work = (async () => {
        if (target.targetInfo.type === "service_worker" && target.targetInfo.url.startsWith(`${origin}/sw.js`)) {
          const url = new URL(target.targetInfo.url);
          if (url.origin !== origin || url.pathname !== "/sw.js") throw new Error("Unexpected native staging worker");
          await send("Network.enable", {}, target.sessionId);
          await send("Network.setBlockedURLs", { urls: blockedURLs() }, target.sessionId);
          workerSessions.add(target.sessionId);
          configured++;
        }
        await send("Runtime.runIfWaitingForDebugger", {}, target.sessionId);
      })().catch(() => { failure = true; });
      configuring.add(work); void work.finally(() => configuring.delete(work));
    } else if (value.method === "Target.detachedFromTarget") workerSessions.delete(z.object({ sessionId: z.string() }).parse(value.params).sessionId);
  };
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "service_worker", exclude: false }, { exclude: true }] });
  await Promise.all([...configuring]);
  return {
    state: () => { if (failure) throw new Error("Native staging worker fault control unavailable"); return { configuredWorkers: configured, blockedWorkerRequests: blocked }; },
    blockAllUploadTransport: async (blocked: boolean) => {
      allUploads = blocked;
      await Promise.all([...workerSessions].map(sessionId => send("Network.setBlockedURLs", { urls: blockedURLs() }, sessionId)));
    },
    close: () => { for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(); } pending.clear(); socket.close(); }
  };
}
