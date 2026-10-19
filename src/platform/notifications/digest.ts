import { z } from "zod";

const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);
export const digestSettingsSchema = z.object({
  frequency: z.enum(["off", "daily", "weekly"]), language: z.enum(["en", "fr", "ar"]),
  timezone: z.string().min(1).max(100).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  time: clock, weekday: z.number().int().min(0).max(6),
  quietHours: z.object({ start: clock, end: clock }).strict().nullable()
}).strict().refine((value) => !value.quietHours || value.quietHours.start !== value.quietHours.end);
export type DigestSettings = z.infer<typeof digestSettingsSchema>;
export const digestEventType = "notification.digest.requested";
export const digestEventSchema = z.object({ recipientId: z.string().uuid(), revision: z.number().int().positive(), scheduledAt: z.iso.datetime() }).strict();
export const digestPolicyKey = "notification.digest.delivery_policy";
export const digestPolicySchema = z.object({
  maxItems: z.number().int().min(1).max(200), maxAttempts: z.number().int().min(1).max(25),
  backoffSeconds: z.number().int().min(1).max(3600), maxBackoffSeconds: z.number().int().min(1).max(21600),
  retryWindowHours: z.number().int().min(1).max(23),
  defaultTime: clock, defaultWeekday: z.number().int().min(0).max(6),
  defaultQuietHours: z.object({ start: clock, end: clock }).strict().nullable()
}).strict();
// Persisted in config_rule, then resolved on every schedule and delivery.
export const initialDigestPolicy: z.infer<typeof digestPolicySchema> = { maxItems: 100, maxAttempts: 5, backoffSeconds: 60, maxBackoffSeconds: 3600,
  retryWindowHours: 23, defaultTime: "09:00", defaultWeekday: 1, defaultQuietHours: { start: "22:00", end: "07:00" } };
export const operationalDigestKinds = ["task_assigned", "task_completed", "task_overdue", "reservation_created", "approval_requested", "approval_decided"] as const;

function localClock(timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (instant: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return { date, time: `${parts.hour}:${parts.minute}`, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
  };
}
export function inDigestQuietHours(settings: DigestSettings, at: Date): boolean {
  const quiet = settings.quietHours;
  if (!quiet) return false;
  const { time } = localClock(settings.timezone)(at);
  return quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end;
}
export function afterDigestQuietHours(settings: DigestSettings, at: Date): Date {
  let result = new Date(at);
  // Walk instants, not UTC offsets: DST gaps, folds and Morocco's Ramadan changes
  // are all resolved using the IANA timezone database.
  for (let i = 0; i < 26 * 60 && inDigestQuietHours(settings, result); i++) result = new Date(Math.floor(result.getTime() / 60000) * 60000 + 60000);
  if (inDigestQuietHours(settings, result)) throw new Error("digest_quiet_hours_invalid");
  return result;
}
export function nextDigestAt(settings: DigestSettings, after: Date): Date | null {
  if (settings.frequency === "off") return null;
  const local = localClock(settings.timezone); const start = local(after);
  let candidate = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < 9 * 24 * 60; i++, candidate = new Date(candidate.getTime() + 60000)) {
    const value = local(candidate);
    // A missed wall time runs at the first following minute. A repeated wall time
    // runs once for that local date, even when the clock moves backwards.
    const eligibleDate = value.date > start.date || (value.date === start.date && settings.time > start.time);
    if (eligibleDate && value.time >= settings.time && (settings.frequency === "daily" || value.weekday === settings.weekday)) return afterDigestQuietHours(settings, candidate);
  }
  throw new Error("digest_schedule_invalid");
}
