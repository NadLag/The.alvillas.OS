import {z} from "zod";

export const payoutCadenceSchema = z.enum([
  "AFTER_CHECKOUT",
  "PER_BOOKING",
  "WEEKLY",
  "FIFTEEN_DAY",
  "MONTHLY",
  "CUSTOM_CRON",
  "OTA_SPLIT_EXPECTED_SETTLEMENT"
]);

export const payoutCalendarSchema = z.object({
  timezone: z.string().trim().min(1).max(100).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
  }).optional(),
  at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  month_day: z.union([z.number().int().min(1).max(31), z.literal("LAST")]).optional(),
  anchor_on: z.iso.date().optional()
}).strict();

export const payoutCronSchema=z.string().trim().min(5).max(120);
