import { describe, expect, it } from "vitest";
import { digestSettingsSchema, initialDigestPolicy, digestPolicySchema, inDigestQuietHours, nextDigestAt, type DigestSettings } from "@/platform/notifications/digest";
import { renderDigestEmail } from "@/platform/email/digest-template";

const settings: DigestSettings = { frequency: "daily", language: "fr", timezone: "Africa/Casablanca", time: "09:00", weekday: 1, quietHours: null };
describe("F-NTF-07 digest scheduling and templates", () => {
  it("resolves local calendar schedules and coalesces missed intervals without catch-up bursts", () => {
    expect(nextDigestAt(settings, new Date("2026-10-16T07:59:00Z"))?.toISOString()).toBe("2026-10-16T08:00:00.000Z");
    expect(nextDigestAt(settings, new Date("2026-10-16T08:00:00Z"))?.toISOString()).toBe("2026-10-17T08:00:00.000Z");
    expect(nextDigestAt({ ...settings, frequency: "weekly" }, new Date("2026-10-16T12:00:00Z"))?.toISOString()).toBe("2026-10-19T08:00:00.000Z");
    expect(nextDigestAt({ ...settings, frequency: "off" }, new Date())).toBeNull();
  });
  it("handles DST gaps, repeated hours and Casablanca Ramadan clock changes", () => {
    const ny = { ...settings, timezone: "America/New_York", time: "02:30" };
    expect(nextDigestAt(ny, new Date("2026-03-08T06:59:00Z"))?.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(nextDigestAt({ ...ny, time: "01:30" }, new Date("2026-11-01T05:30:00Z"))?.toISOString()).toBe("2026-11-02T06:30:00.000Z");
    expect(nextDigestAt(settings, new Date("2026-02-20T08:30:00Z"))?.toISOString()).toBe("2026-02-20T09:00:00.000Z");
  });
  it("defers overnight and daytime quiet intervals and treats the end as inclusive", () => {
    const quiet = { ...settings, time: "23:00", quietHours: { start: "22:00", end: "07:00" } };
    expect(nextDigestAt(quiet, new Date("2026-10-16T20:00:00Z"))?.toISOString()).toBe("2026-10-17T06:00:00.000Z");
    expect(inDigestQuietHours(quiet, new Date("2026-10-17T06:00:00Z"))).toBe(false);
    expect(nextDigestAt({ ...settings, quietHours: { start: "08:00", end: "12:00" } }, new Date("2026-10-16T06:00:00Z"))?.toISOString()).toBe("2026-10-16T11:00:00.000Z");
  });
  it("rejects unknown timezones, invalid times, 24h quiet periods and unsafe retry windows", () => {
    for (const patch of [{ timezone: "Mars/Casablanca" }, { time: "24:00" }, { weekday: 7 }, { quietHours: { start: "09:00", end: "09:00" } }, { language: "xx" }]) expect(digestSettingsSchema.safeParse({ ...settings, ...patch }).success).toBe(false);
    expect(digestPolicySchema.safeParse({ ...initialDigestPolicy, retryWindowHours: 24 }).success).toBe(false);
  });
  it.each(["en", "fr", "ar"] as const)("renders %s only from localized safe labels and authenticated notification references", (language) => {
    const id = "018f0a0b-0000-7000-9000-000000000001";
    const result = renderDigestEmail({ to: "recipient@example.test", settings: { ...settings, language }, scheduledAt: new Date("2026-10-16T08:00:00Z"),
      items: [{ id, kind: "task_assigned", createdAt: new Date() }], appUrl: "https://os.example.test" });
    expect(result.locale).toBe(language); expect(result.html).toContain(`lang="${language}"`);
    expect(result.html).toContain(`dir="${language === "ar" ? "rtl" : "ltr"}"`);
    expect(result.text).toContain(`https://os.example.test/${language}/app/notifications/open/${id}`);
    expect(result.text).not.toContain("recipient@example.test"); expect(result.html).not.toContain("undefined");
    expect(result.template).toBe("notification.digest");
  });
  it("rejects foreign origins, injected ids and non-operational kinds", () => {
    const input = { to: "recipient@example.test", settings, scheduledAt: new Date(), items: [{ id: crypto.randomUUID(), kind: "task_completed", createdAt: new Date() }], appUrl: "https://os.example.test" };
    for (const appUrl of ["http://external.example.test", "https://user:password@os.example.test", "javascript:alert(1)"]) expect(() => renderDigestEmail({ ...input, appUrl })).toThrow();
    for (const kind of ["language_updated", "security_session_revoked", "<script>"]) expect(() => renderDigestEmail({ ...input, items: [{ ...input.items[0], kind }] })).toThrow();
  });
});
