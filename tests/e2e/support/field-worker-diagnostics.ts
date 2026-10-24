import type { Page } from "@playwright/test";

export async function inspectFieldWorker(page: Page) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([probeFieldWorker(page).catch(() => [{ probeUnavailable: true }]), new Promise<unknown[]>(resolve => {
      timeout = setTimeout(() => resolve([{ probeTimedOut: true }]), 3000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}
async function probeFieldWorker(page: Page) {
  const session = await page.context().newCDPSession(page);
  const results: unknown[] = [];
  try {
    const targets = await session.send("Target.getTargets");
    for (const target of targets.targetInfos.filter(target => target.type === "service_worker" && target.url.startsWith("http://127.0.0.1:3000/sw.js"))) {
      const attached = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const reply = new Promise<unknown>(resolve => {
        const receive = (event: { sessionId: string; message: string }) => {
          if (event.sessionId !== attached.sessionId) return;
          const message: unknown = JSON.parse(event.message);
          if (!message || typeof message !== "object" || !("id" in message) || message.id !== 101) return;
          session.off("Target.receivedMessageFromTarget", receive); resolve(message);
        };
        session.on("Target.receivedMessageFromTarget", receive);
        timeout = setTimeout(() => { session.off("Target.receivedMessageFromTarget", receive); resolve({ unavailable: true }); }, 1000);
      });
      await session.send("Target.sendMessageToTarget", { sessionId: attached.sessionId, message: JSON.stringify({ id: 101, method: "Runtime.evaluate", params: {
        expression: '(() => { const events = getEventListeners(self); return { listeners: Object.fromEntries(Object.entries(events).map(([name, list]) => [name, list.length])), activationHandler: (events.message ?? []).some(entry => String(entry.listener).includes("ALVILLAS_SKIP_WAITING")), held: self.fieldHeldDiagnostic, background: self.fieldBackgroundDiagnostic }; })()',
        includeCommandLineAPI: true, returnByValue: true
      } }) });
      results.push({ script: new URL(target.url).pathname + new URL(target.url).search, listenerProbe: await reply });
      if (timeout) clearTimeout(timeout);
      await session.send("Target.detachFromTarget", { sessionId: attached.sessionId });
    }
    return results;
  } catch { return [...results, { probeUnavailable: true }]; }
  finally { await session.detach(); }
}
