import { z } from "zod";

export const accountingPeriodPolicyKey = "finance.accounting_periods";
export const accountingPeriodPolicySchema = z.object({
  timezone: z.string().trim().min(1).max(120).refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
  }),
  allow_early_close: z.boolean(),
  max_reopen_seconds: z.number().int().positive().max(2147483647)
}).strict();
export type AccountingPeriodPolicy = z.infer<typeof accountingPeriodPolicySchema>;
const uuid = z.uuid().transform(value => value.toLowerCase());
export const accountingMonthSchema = z.string().trim().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u)
  .refine(value => Number(value.slice(0, 4)) > 0);
const reason = z.string().trim().min(3).max(1000);
export const closeAccountingPeriodSchema = z.object({ month: accountingMonthSchema,
  expectedVersion: z.number().int().nonnegative(), reason, idempotencyKey: uuid }).strict();
export const reopenAccountingPeriodSchema = z.object({ periodId: uuid, expectedVersion: z.number().int().positive(),
  reason, durationSeconds: z.number().int().positive().max(2147483647), idempotencyKey: uuid }).strict();
export const accountingPeriodSnapshotSchema = z.object({ version: z.literal(1), transactions: z.number().int().nonnegative(),
  postings: z.number().int().nonnegative(), unsealed: z.number().int().nonnegative(), financialHash: z.string().regex(/^[a-f0-9]{64}$/u),
  currencies: z.array(z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), debit: z.string(), credit: z.string() }).strict()) }).strict();

export function accountingPeriodState(event: { kind: string; reopensUntil: Date | null } | undefined, now: Date): "CLOSED" | "REOPENED" {
  return event?.kind === "REOPEN" && event.reopensUntil && event.reopensUntil > now ? "REOPENED" : "CLOSED";
}

export class AccountingPeriodClosedError extends Error {}
export class AccountingPeriodAccessError extends Error {}
export class AccountingPeriodConflictError extends Error {}
export class AccountingPeriodPolicyError extends Error {
  constructor(readonly code: "missingPolicy" | "earlyClose" | "invalidWindow" | "unbalanced" | "timezoneData" = "missingPolicy") { super(code); }
}
