import { z } from "zod";
import Decimal from "decimal.js";
import { localizedTextSchema } from "@/i18n/content";
import { automationEvents } from "./events";

const slug = z.string().regex(/^[a-z][a-z0-9_.-]{0,99}$/u);
const path = z
  .string()
  .max(160)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/u)
  .refine(
    (v) =>
      !v
        .split(".")
        .some((p) => ["__proto__", "prototype", "constructor"].includes(p)),
  );
export type Operand =
  | string
  | number
  | boolean
  | null
  | Operand[]
  | { field: string }
  | { config: string; path?: string };
const operand: z.ZodType<Operand> = z.lazy(() =>
  z.union([
    z.string().max(500),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(operand).max(100),
    z.object({ field: path }).strict(),
    z.object({ config: z.string().max(160), path: path.optional() }).strict(),
  ]),
);
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      path: string;
      op:
        | "="
        | "!="
        | ">"
        | ">="
        | "<"
        | "<="
        | "in"
        | "not_in"
        | "exists"
        | "between";
      value?: Operand;
    };
const condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(condition).max(30) }).strict(),
    z.object({ any: z.array(condition).max(30) }).strict(),
    z.object({ not: condition }).strict(),
    z
      .object({
        path,
        op: z.enum([
          "=",
          "!=",
          ">",
          ">=",
          "<",
          "<=",
          "in",
          "not_in",
          "exists",
          "between",
        ]),
        value: operand.optional(),
      })
      .strict(),
  ]),
);
// Check size/depth before Zod recurses, including untrusted JSON posted to actions.
export function boundedJson(
  value: unknown,
  depth = 0,
  budget = { remaining: 2000 },
): boolean {
  if (depth > 16 || --budget.remaining < 0) return false;
  return (
    !value ||
    typeof value !== "object" ||
    Object.values(value).every((v) => boundedJson(v, depth + 1, budget))
  );
}
const due = z
  .object({
    from: path,
    offset_days: z.union([
      z.number().int().min(-366).max(366),
      z.string().max(120),
    ]),
  })
  .strict();
export const automationActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      key: slug,
      type: z.literal("create_task"),
      task_type: z.string().min(1).max(50),
      title: localizedTextSchema,
      due,
      priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
      checklist_template: slug,
      assign: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      key: slug,
      type: z.literal("create_approval_request"),
      title: localizedTextSchema,
      details: localizedTextSchema,
    })
    .strict(),
  z
    .object({
      key: slug,
      type: z.literal("reorder_suggestion"),
      title: localizedTextSchema,
    })
    .strict(),
  z
    .object({
      key: slug,
      type: z.literal("notify"),
      kind: z.enum([
        "task_assigned",
        "task_completed",
        "task_overdue",
        "reservation_created",
        "approval_requested",
        "approval_decided",
      ]),
      recipient: path,
      target: path,
    })
    .strict(),
  z.object({ key: slug, type: z.literal("generate_workflow") }).strict(),
  z.object({ key: slug, type: z.literal("snapshot") }).strict(),
  z
    .object({
      key: slug,
      type: z.literal("create_variance"),
      expected: path,
      actual: path,
      currency: path,
      reason: localizedTextSchema,
    })
    .strict(),
]);
export const automationRuleSchema = z
  .unknown()
  .refine(boundedJson)
  .pipe(
    z
      .object({
        name: localizedTextSchema,
        event: z.enum(automationEvents),
        enabled: z.boolean(),
        conditions: condition,
        actions: z.array(automationActionSchema).min(1).max(20),
        idempotency_key: z.string().min(1).max(250).optional(),
        retry: z
          .object({
            max_attempts: z.number().int().min(1).max(25),
            delay_seconds: z.number().int().min(1).max(86400),
          })
          .strict(),
        schedule: z
          .object({
            hour: z.number().int().min(0).max(23),
            minute: z.number().int().min(0).max(59),
            weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
            timezone: z
              .string()
              .max(100)
              .refine((v) => {
                try {
                  new Intl.DateTimeFormat("en", { timeZone: v });
                  return true;
                } catch {
                  return false;
                }
              })
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (r) => new Set(r.actions.map((a) => a.key)).size === r.actions.length,
      ),
  );
export type AutomationRule = z.infer<typeof automationRuleSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type EvaluationContext = {
  fields: Record<string, unknown>;
  configs: Record<string, unknown>;
};
export function field(object: unknown, key: string): unknown {
  if (!path.safeParse(key).success) throw new Error("automation_path_invalid");
  return key
    .split(".")
    .reduce<unknown>(
      (v, p) =>
        v && typeof v === "object" && Object.hasOwn(v, p)
          ? (v as Record<string, unknown>)[p]
          : undefined,
      object,
    );
}
export function resolveOperand(
  v: Operand | undefined,
  ctx: EvaluationContext,
): unknown {
  if (Array.isArray(v)) return v.map((x) => resolveOperand(x, ctx));
  if (v && typeof v === "object") {
    if ("field" in v) return field(ctx.fields, v.field);
    if (!Object.hasOwn(ctx.configs, v.config))
      throw new Error("automation_config_missing");
    return v.path
      ? field(ctx.configs[v.config], v.path)
      : ctx.configs[v.config];
  }
  return v;
}
function compare(a: unknown, b: unknown): number | null {
  if (
    (typeof a === "number" || typeof a === "string") &&
    (typeof b === "number" || typeof b === "string")
  ) {
    if (
      /^-?\d+(\.\d+)?$/u.test(String(a)) &&
      /^-?\d+(\.\d+)?$/u.test(String(b))
    )
      return new Decimal(a).cmp(new Decimal(b));
    if (typeof a === "string" && typeof b === "string")
      return a < b ? -1 : a > b ? 1 : 0;
  }
  return null;
}
export function evaluate(
  c: Condition,
  ctx: EvaluationContext,
  depth = 0,
): boolean {
  if (depth > 16) throw new Error("automation_condition_depth");
  if ("all" in c) return c.all.every((x) => evaluate(x, ctx, depth + 1));
  if ("any" in c) return c.any.some((x) => evaluate(x, ctx, depth + 1));
  if ("not" in c) return !evaluate(c.not, ctx, depth + 1);
  const a = field(ctx.fields, c.path),
    b = resolveOperand(c.value, ctx);
  if (c.op === "exists") return (a !== undefined && a !== null) === (b ?? true);
  if (a === undefined || b === undefined) return false;
  if (c.op === "=") return a === b;
  if (c.op === "!=") return a !== b;
  if (c.op === "in" || c.op === "not_in")
    return Array.isArray(b) && (c.op === "in" ? b.includes(a) : !b.includes(a));
  if (c.op === "between")
    return (
      Array.isArray(b) &&
      b.length === 2 &&
      (compare(a, b[0]) ?? -1) >= 0 &&
      (compare(a, b[1]) ?? 1) <= 0
    );
  const n = compare(a, b);
  if (n === null) return false;
  return c.op === ">"
    ? n > 0
    : c.op === ">="
      ? n >= 0
      : c.op === "<"
        ? n < 0
        : n <= 0;
}
export function referencedConfigs(value: unknown): string[] {
  const keys = new Set<string>();
  function visit(v: unknown) {
    if (!v || typeof v !== "object") return;
    if ("config" in v && typeof v.config === "string") keys.add(v.config);
    Object.values(v).forEach(visit);
  }
  visit(value);
  return [...keys];
}
// A token parser, never JavaScript: bounded numbers, arithmetic and four pure functions.
export function expression(
  source: string,
  variables: Record<string, number>,
): number {
  if (source.length > 120) throw new Error("automation_expression_invalid");
  const tokens =
    source.match(/\d+(?:\.\d+)?|[a-zA-Z_][a-zA-Z0-9_.]*|[()+\-*/,]/gu) ?? [];
  if (tokens.join("") !== source.replace(/\s/gu, ""))
    throw new Error("automation_expression_invalid");
  let i = 0;
  function atom(): number {
    const t = tokens[i++];
    if (t === "-") return -atom();
    if (t === "(") {
      const v = sum();
      if (tokens[i++] !== ")") throw new Error("automation_expression_invalid");
      return v;
    }
    if (t && /^\d/u.test(t)) return Number(t);
    if (t && ["floor", "ceil", "min", "max"].includes(t)) {
      if (tokens[i++] !== "(") throw new Error("automation_expression_invalid");
      const args = [sum()];
      while (tokens[i] === ",") {
        i++;
        args.push(sum());
      }
      if (
        tokens[i++] !== ")" ||
        (["floor", "ceil"].includes(t) && args.length !== 1)
      )
        throw new Error("automation_expression_invalid");
      return t === "floor"
        ? Math.floor(args[0])
        : t === "ceil"
          ? Math.ceil(args[0])
          : t === "min"
            ? Math.min(...args)
            : Math.max(...args);
    }
    if (t && Object.hasOwn(variables, t)) return variables[t];
    throw new Error("automation_expression_invalid");
  }
  function product(): number {
    let n = atom();
    while (["*", "/"].includes(tokens[i])) {
      const op = tokens[i++],
        b = atom();
      n = op === "*" ? n * b : n / b;
    }
    return n;
  }
  function sum(): number {
    let n = product();
    while (["+", "-"].includes(tokens[i])) {
      const op = tokens[i++],
        b = product();
      n = op === "+" ? n + b : n - b;
    }
    return n;
  }
  const result = sum();
  if (i !== tokens.length || !Number.isFinite(result) || Math.abs(result) > 366)
    throw new Error("automation_expression_invalid");
  return result;
}
export function dueDate(
  action: Extract<AutomationAction, { type: "create_task" }>,
  ctx: EvaluationContext,
) {
  const base = field(ctx.fields, action.due.from);
  if (typeof base !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(base))
    throw new Error("automation_due_invalid");
  const offset =
    typeof action.due.offset_days === "number"
      ? action.due.offset_days
      : expression(action.due.offset_days, {
          nights: Number(field(ctx.fields, "reservation.nights")),
        });
  if (!Number.isInteger(offset)) throw new Error("automation_due_invalid");
  const date = new Date(base + "T00:00:00Z");
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== base
  )
    throw new Error("automation_due_invalid");
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function scheduleSlot(
  rule: AutomationRule,
  timezone: string,
  now: Date,
): string | null {
  if (!rule.schedule) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: rule.schedule.timezone ?? timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(date + "T00:00:00Z").getUTCDay();
  return rule.schedule.weekdays.includes(weekday) &&
    Number(parts.hour) * 60 + Number(parts.minute) >=
      rule.schedule.hour * 60 + rule.schedule.minute
    ? date
    : null;
}
