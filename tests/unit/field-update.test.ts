import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshFieldApp } from "@/platform/offline/field-update";

class UpdateChannel {
  static latest: UpdateChannel;
  port1 = { close: vi.fn(), onmessage: null as ((event: { data: unknown }) => void) | null };
  port2 = {};
  constructor() { UpdateChannel.latest = this; }
}
function waitingWorker() {
  let state: ServiceWorkerState = "installed";
  const target = new EventTarget(), postMessage = vi.fn();
  Object.defineProperty(target, "state", { get: () => state });
  Object.assign(target, { postMessage });
  return { worker: target as ServiceWorker, postMessage,
    state(value: ServiceWorkerState, dispatch = true) { state = value; if (dispatch) target.dispatchEvent(new Event("statechange")); } };
}
const registration = (waiting: ServiceWorker | null) => ({ waiting }) as ServiceWorkerRegistration;
let controller: ServiceWorker | null;
let serviceWorkers: ServiceWorkerContainer;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
  vi.stubGlobal("MessageChannel", UpdateChannel);
  controller = null;
  serviceWorkers = new EventTarget() as ServiceWorkerContainer;
  Object.defineProperty(serviceWorkers, "controller", { get: () => controller });
  vi.stubGlobal("navigator", { serviceWorker: serviceWorkers });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("explicit field worker refresh", () => {
  it("does not reload after an acknowledgement until the replacement worker is activated", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn();
    waiting.postMessage.mockImplementation(() => {
      waiting.state("activating"); UpdateChannel.latest.port1.onmessage?.({ data: { type: "ALVILLAS_UPDATE_READY" } });
    });
    refreshFieldApp(registration(waiting.worker), reload, unavailable);
    expect(reload).not.toHaveBeenCalled(); controller = waiting.worker; waiting.state("activated"); vi.advanceTimersByTime(0);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("recovers an activated worker when both acknowledgement and state notification are missed", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn();
    refreshFieldApp(registration(waiting.worker), reload, unavailable); controller = waiting.worker; waiting.state("activated", false); vi.advanceTimersByTime(3000);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled();
  });
  it("preserves the current page and allows retry when activation stalls", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn();
    waiting.postMessage.mockImplementation(() => waiting.state("activating"));
    refreshFieldApp(registration(waiting.worker), reload, unavailable); vi.advanceTimersByTime(3000);
    expect(reload).not.toHaveBeenCalled(); expect(unavailable).toHaveBeenCalledTimes(1); expect(UpdateChannel.latest.port1.close).toHaveBeenCalledTimes(1);
  });
  it("reloads directly when no replacement worker is waiting", () => {
    const reload = vi.fn(), unavailable = vi.fn(); refreshFieldApp(registration(null), reload, unavailable);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled();
  });
  it("preserves the page if the waiting worker cannot receive the update request", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn(); waiting.postMessage.mockImplementation(() => { throw Error("Worker unavailable"); });
    refreshFieldApp(registration(waiting.worker), reload, unavailable);
    expect(reload).not.toHaveBeenCalled(); expect(unavailable).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for controller adoption after the replacement reports activated", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn();
    refreshFieldApp(registration(waiting.worker), reload, unavailable);
    waiting.state("activated");
    expect(reload).not.toHaveBeenCalled();
    controller = waiting.worker; serviceWorkers.dispatchEvent(new Event("controllerchange"));
    vi.advanceTimersByTime(50);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for the activating active worker after the waiting slot has cleared", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn(); waiting.state("activating");
    const updating = { waiting: null, active: waiting.worker } as ServiceWorkerRegistration;
    refreshFieldApp(updating, reload, unavailable);
    expect(reload).not.toHaveBeenCalled();
    controller = waiting.worker; waiting.state("activated"); vi.advanceTimersByTime(50);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled(); expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries an undelivered activation request without reusing its transferred port", () => {
    const waiting = waitingWorker(), reload = vi.fn(), unavailable = vi.fn();
    waiting.postMessage.mockImplementationOnce(() => undefined).mockImplementation(() => {
      controller = waiting.worker; waiting.state("activated");
    });
    refreshFieldApp(registration(waiting.worker), reload, unavailable);
    expect(waiting.postMessage).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(waiting.postMessage).toHaveBeenCalledTimes(2);
    expect(waiting.postMessage.mock.calls[1]).toEqual([{ type: "ALVILLAS_SKIP_WAITING" }]);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("follows a replacement waiting worker and requires that worker to control the document", () => {
    const first = waitingWorker(), replacement = waitingWorker(), reload = vi.fn(), unavailable = vi.fn();
    let current = first.worker;
    const changing = { get waiting() { return current; } } as ServiceWorkerRegistration;
    refreshFieldApp(changing, reload, unavailable);
    replacement.postMessage.mockImplementation(() => { replacement.state("activated"); controller = replacement.worker; });
    current = replacement.worker; controller = first.worker;
    vi.advanceTimersByTime(50);
    expect(replacement.postMessage).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1); expect(unavailable).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
