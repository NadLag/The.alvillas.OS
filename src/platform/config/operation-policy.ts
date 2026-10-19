import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
const slug = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9_.-]+$/u);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (v) =>
      Number.isFinite(new Date(v + "T00:00:00Z").getTime()) &&
      new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v,
  );
export const operationPolicySchema = z
  .object({
    shift_start_minute: z.number().int().min(0).max(1439),
    risk_window_minutes: z.number().int().min(0).max(10080),
    recurrence_horizon_days: z.number().int().min(1).max(90),
    recurrence_lookback_days: z.number().int().min(0).max(366),
    evidence_max_bytes: z.number().int().min(1).max(4000000),
    evidence_link_seconds: z.number().int().min(30).max(900),
    readiness_types: z.array(z.string().min(1)).min(1).max(20),
    types: z.record(
      z.string().min(1),
      z
        .object({
          role_keys: z.array(slug).min(1).max(24),
          preferred_people: z.array(z.uuid()).max(100),
          fallback_people: z.array(z.uuid()).max(100),
          max_daily_tasks: z.number().int().min(1).max(100),
          duration_minutes: z.number().int().min(1).max(1440),
          start_minute: z.number().int().min(0).max(1439).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type OperationPolicy = z.infer<typeof operationPolicySchema>;
export const recurringTaskDefinitionSchema = z
  .object({
    key: slug,
    type: z.string().min(1),
    title: localizedTextSchema,
    checklist_template_key: slug,
    starts_on: date,
    ends_on: date.nullable(),
    every_days: z.number().int().min(1).max(366),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start_minute: z.number().int().min(0).max(1439),
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
    enabled: z.boolean(),
  })
  .strict()
  .refine((v) => !v.ends_on || v.ends_on >= v.starts_on);
export const recurringTasksSchema = z
  .object({
    series: z
      .array(recurringTaskDefinitionSchema)
      .max(100)
      .refine((v) => new Set(v.map((s) => s.key)).size === v.length),
  })
  .strict();
