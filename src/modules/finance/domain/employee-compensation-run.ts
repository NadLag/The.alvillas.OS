import { z } from "zod";
import { accountingPeriodPolicySchema } from "./accounting-period";
import { calendarDateStart } from "@/platform/time/calendar";

export const employeeCompensationRunPolicyKey = "staff.compensation_runs";
export const employeeCompensationRunPolicySchema = z.object({
  earning_date: z.literal("RECORDED_COMPLETION"),
  timezone: accountingPeriodPolicySchema.shape.timezone,
  max_period_days: z.number().int().positive().max(2147483647)
}).strict();
const id = z.uuid().transform(value => value.toLowerCase());
export const employeeCompensationRunCreateSchema = z.object({
  fromOn: z.iso.date(), toOn: z.iso.date(), currency: z.string().regex(/^[A-Z]{3}$/u),
  purpose: z.string().trim().min(3).max(1000), reason: z.string().trim().min(6).max(500), idempotencyKey: id,
  jobs: z.array(z.object({ taskId: id, assignmentId: id, confirmedAssignment: z.literal(true) }).strict()).min(1).max(10000)
}).strict().superRefine((value, ctx) => {
  if (value.fromOn > value.toOn) ctx.addIssue({ code: "custom", path: ["toOn"], message: "Run period must be ordered" });
  if (new Set(value.jobs.map(job => job.taskId)).size !== value.jobs.length)
    ctx.addIssue({ code: "custom", path: ["jobs"], message: "Each actual completed task belongs once in a run" });
});
export const employeeCompensationRunCancelSchema = z.object({ id, reason: z.string().trim().min(6).max(500) }).strict();
export class EmployeeCompensationRunAccessError extends Error {}
export class EmployeeCompensationRunConflictError extends Error {}
export class EmployeeCompensationRunPolicyError extends Error {}

const runMoney = z.object({ amount: z.string().max(128).regex(/^(?:0|[1-9]\d*)\.\d{2}$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict();
export const employeeCompensationRunViewSchema = z.object({
  id, kind: z.enum(["COMPLETED_WORK_DRAFT","MONTHLY_CONTRACT_DRAFT","HOURLY_WORK_DRAFT"]), state: z.enum(["DRAFT","CANCELLED"]), purpose: z.string(),
  fromOn: z.iso.date(), toOn: z.iso.date(), timezone: z.string(), currency: z.string().regex(/^[A-Z]{3}$/u), createdAt: z.iso.datetime(),
  total: runMoney, lineCount: z.number().int().positive(),
  lines: z.array(z.object({ id, taskId: id.nullable(), personId: id, propertyId: id.nullable(), assignmentId: id, completionEventId: id.nullable(),earningKind:z.enum(["PER_MONTH","PER_HOUR"]).optional(),earningPeriodKey:z.string().optional(),
    recordedCompletionAt: z.iso.datetime(), rate: runMoney, amount: runMoney }).strict()).max(50),
  nextCursor: id.nullable(), history: z.array(z.object({ action: z.enum(["CREATED","CANCELLED"]), at: z.iso.datetime(), reason: z.string() }).strict()).min(1).max(2)
}).strict();

/** Calendar date arithmetic happens before conversion to the configured earning timezone. */
export function employeeCompensationRunWindow(fromOn: string, toOn: string, rawPolicy: unknown) {
  const policy = employeeCompensationRunPolicySchema.parse(rawPolicy);
  const from = z.iso.date().parse(fromOn), to = z.iso.date().parse(toOn);
  const startDay = new Date(from + "T00:00:00.000Z"), lastDay = new Date(to + "T00:00:00.000Z");
  const days = (lastDay.getTime() - startDay.getTime()) / 86400000 + 1;
  if (days < 1 || days > policy.max_period_days) throw new EmployeeCompensationRunPolicyError();
  lastDay.setUTCDate(lastDay.getUTCDate() + 1);
  return { policy, days, startsAt: calendarDateStart(from, policy.timezone), endsAt: calendarDateStart(lastDay.toISOString().slice(0,10), policy.timezone) };
}
