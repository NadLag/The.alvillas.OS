import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { usePushLifecycle as attachPushLifecycle } from "@/platform/notifications/push-lifecycle";
import { pushRevokeAction } from "@/platform/notifications/notification-actions";

vi.mock("react", () => ({ useEffect: vi.fn() }));
vi.mock("@/platform/notifications/notification-actions", () => ({
  pushRevokeAction: vi.fn(() => Promise.resolve({ ok: true })), pushSettingsAction: vi.fn(), pushSubscribeAction: vi.fn()
}));
let cleanup: (() => void) | void;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("browser push lifecycle message boundaries", () => {
  it("ignores field acknowledgements while retaining subscription, permission and focus reconciliation", async () => {
    const worker = Object.assign(new EventTarget(), { getRegistration: vi.fn(() => Promise.resolve(undefined)) });
    const permission = Object.assign(new EventTarget(), { state: "prompt" });
    const windowEvents = Object.assign(new EventTarget(), { isSecureContext: true, PushManager: {}, Notification: {} });
    vi.stubGlobal("window", windowEvents); vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("navigator", { onLine: true, serviceWorker: worker, permissions: { query: vi.fn(() => Promise.resolve(permission)) } });
    vi.stubGlobal("Notification", { permission: "default" });
    vi.mocked(useEffect).mockImplementation(effect => { cleanup = effect(); });
    attachPushLifecycle();
    await vi.waitFor(() => expect(pushRevokeAction).toHaveBeenCalledTimes(1));
    worker.getRegistration.mockClear(); vi.mocked(pushRevokeAction).mockClear();
    for (const data of [{ type: "alvillas-field-acknowledged", detail: {} }, { type: "alvillas-field-sync-finished", result: "synced" }, null, { type: "unknown" }]) {
      worker.dispatchEvent(new MessageEvent("message", { data }));
    }
    expect(worker.getRegistration).not.toHaveBeenCalled(); expect(pushRevokeAction).not.toHaveBeenCalled();
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "alvillas-push-subscription-changed" } }));
    await vi.waitFor(() => expect(pushRevokeAction).toHaveBeenCalledTimes(1));
    expect(pushRevokeAction).toHaveBeenLastCalledWith({ id: null, reason: "permission_revoked" });
    permission.dispatchEvent(new Event("change")); await vi.waitFor(() => expect(pushRevokeAction).toHaveBeenCalledTimes(2));
    windowEvents.dispatchEvent(new Event("focus")); await vi.waitFor(() => expect(pushRevokeAction).toHaveBeenCalledTimes(3));
    cleanup?.(); cleanup = undefined;
    worker.dispatchEvent(new MessageEvent("message", { data: { type: "alvillas-push-subscription-changed" } }));
    windowEvents.dispatchEvent(new Event("focus")); permission.dispatchEvent(new Event("change"));
    expect(pushRevokeAction).toHaveBeenCalledTimes(3);
  });
});
