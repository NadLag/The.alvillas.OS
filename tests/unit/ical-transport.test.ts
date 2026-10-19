import { afterEach, expect, it, vi } from "vitest";
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:dns/promises", () => dns);
vi.mock("node:https", () => https);
import { fetchIcalFeed } from "@/modules/reservations/infrastructure/ical-transport";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("bounds the entire feed fetch when DNS never resolves and returns only safe diagnostics", async () => {
  vi.useFakeTimers(); dns.lookup.mockReturnValue(new Promise<never>(() => {}));
  const result = expect(fetchIcalFeed("https://www.airbnb.com/calendar/private-test.ics?token=do-not-log", { etag: null, lastModified: null })).rejects.toThrow("feed_transport_failed");
  await vi.advanceTimersByTimeAsync(15000);
  await result;
  expect(https.request).not.toHaveBeenCalled();
});

it("rejects a private DNS resolution before connecting", async () => {
  dns.lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
  await expect(fetchIcalFeed("https://calendar.example.test/private", { etag: null, lastModified: null })).rejects.toThrow("feed_transport_failed");
  expect(https.request).not.toHaveBeenCalled();
});
