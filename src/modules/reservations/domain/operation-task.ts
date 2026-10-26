import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { stayDateSchema } from "./reservation";
import { recurringTaskDefinitionSchema } from "@/platform/config/operation-policy";

export const taskStates = [
  "PLANNED",
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "SKIPPED",
  "CANCELLED",
  "BLOCKED",
] as const;
export const taskStateSchema = z.enum(taskStates);
export const taskPriorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const terminalTaskStates: readonly string[] = [
  "COMPLETED",
  "CANCELLED",
  "SKIPPED",
];
const transitions: Record<string, readonly string[]> = {
  PLANNED: ["ASSIGNED", "SKIPPED", "CANCELLED", "BLOCKED"],
  ASSIGNED: ["IN_PROGRESS", "SKIPPED", "CANCELLED", "BLOCKED"],
  IN_PROGRESS: ["COMPLETED", "SKIPPED", "CANCELLED", "BLOCKED"],
  BLOCKED: ["PLANNED", "ASSIGNED", "SKIPPED", "CANCELLED"],
  COMPLETED: [],
  SKIPPED: [],
  CANCELLED: [],
};
export function canTransitionTask(from: string, to: string) {
  return transitions[from]?.includes(to) ?? false;
}
export const taskReasonSchema = z.string().trim().min(6).max(1000);
export const createTaskSchema = z
  .object({
    propertyId: z.string().uuid(),
    reservationId: z.string().uuid().optional(),
    type: taskTypeSchema,
    title: localizedTextSchema,
    dueDate: stayDateSchema,
    priority: z.enum(taskPriorities),
    checklistTemplateKey: z.string().trim().min(1).max(120),
    idempotencyKey: z.string().uuid(),
    reason: taskReasonSchema,
  })
  .strict();
export const taskCommandSchema = z
  .object({
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    state: taskStateSchema,
    reason: taskReasonSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const proxyCompleteTaskSchema = z
  .object({
    taskId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    performedByPersonId: z.string().uuid(),
    checklistItemIds: z.array(z.string().uuid()).min(1).max(50),
    reason: taskReasonSchema,
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export const assignmentCommandSchema = z
  .object({
    taskId: z.uuid(),
    expectedVersion: z.number().int().min(1),
    personId: z.uuid().nullable(),
    startMinute: z.number().int().min(0).max(1439),
    reason: taskReasonSchema,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const rescheduleTaskSchema = z
  .object({
    taskId: z.uuid(),
    expectedVersion: z.number().int().min(1),
    dueDate: stayDateSchema,
    startMinute: z.number().int().min(0).max(1439),
    reason: taskReasonSchema,
    idempotencyKey: z.uuid(),
  })
  .strict();
export const swapTaskSchema = z
  .object({
    taskId: z.uuid(),
    otherTaskId: z.uuid(),
    expectedVersion: z.number().int().min(1),
    otherVersion: z.number().int().min(1),
    reason: taskReasonSchema,
    idempotencyKey: z.uuid(),
  })
  .strict()
  .refine((v) => v.taskId !== v.otherTaskId);
export const taskViewModes = [
  "TIMELINE",
  "LIST",
  "DAY",
  "WEEK",
  "MONTH",
] as const;
const optionalId = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.uuid().optional(),
);
export const taskQuerySchema = z
  .object({
    view: z.enum(taskViewModes).default("LIST"),
    date: z.preprocess(
      (v) => (v === "" ? undefined : v),
      stayDateSchema.optional(),
    ),
    propertyId: optionalId,
    workerId: optionalId,
    role: z.string().max(120).optional(),
    state: z
      .union([
        taskStateSchema,
        z.literal("OVERDUE"),
        z.literal("AT_RISK"),
        z.literal(""),
      ])
      .optional(),
    priority: z.union([z.enum(taskPriorities), z.literal("")]).optional(),
    type: z.union([taskTypeSchema, z.literal("")]).optional(),
    from: z.preprocess(
      (v) => (v === "" ? undefined : v),
      stayDateSchema.optional(),
    ),
    until: z.preprocess(
      (v) => (v === "" ? undefined : v),
      stayDateSchema.optional(),
    ),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict()
  .refine((v) => !v.from || !v.until || v.from <= v.until);
export const bulkTaskSchema = z
  .object({
    items: z
      .array(
        z.object({
          taskId: z.uuid(),
          expectedVersion: z.number().int().min(1),
        }),
      )
      .min(1)
      .max(200)
      .refine((v) => new Set(v.map((t) => t.taskId)).size === v.length),
    action: z.enum(["ASSIGN", "RESCHEDULE", "CANCEL", "PRIORITY"]),
    personId: z.uuid().nullable(),
    dueDate: stayDateSchema.optional(),
    priority: z.enum(taskPriorities).optional(),
    startMinute: z.number().int().min(0).max(1439).optional(),
    reason: taskReasonSchema,
    idempotencyKey: z.uuid(),
  })
  .strict()
  .refine((v) => v.action !== "RESCHEDULE" || Boolean(v.dueDate))
  .refine((v) => v.action !== "PRIORITY" || Boolean(v.priority));
export const progressInputSchema = z
  .object({
    taskId: z.uuid(),
    idempotencyKey: z.uuid(),
    checklistItemIds: z.array(z.uuid()).max(50),
  })
  .strict();
export const evidenceInputSchema = z
  .object({
    taskId: z.uuid(),
    note: z.string().trim().min(1).max(1000),
    idempotencyKey: z.uuid(),
    contentType: z.enum(["image/jpeg", "image/png"]).optional(),
  })
  .strict();
export const issueInputSchema = z
  .object({
    taskId: z.uuid(),
    title: z.string().trim().min(1).max(240),
    description: z.string().trim().min(6).max(1000),
    severity: z.enum(taskPriorities),
    idempotencyKey: z.uuid(),
    photoClientOpId: z.uuid().optional(),
  })
  .strict();
export function propertyInstant(
  date: string,
  minute: number,
  timezone: string,
): Date {
  const [y, m, d] = date.split("-").map(Number),
    target = Date.UTC(y, m - 1, d, 0, minute),
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  let guess = target;
  for (let i = 0; i < 5; i++) {
    const parts = Object.fromEntries(
      format.formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    if (local === target) return new Date(guess);
    guess += target - local;
  }
  throw new Error("operation_local_time_unavailable");
}
export function propertyMinute(date: Date, timezone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) * 60 + Number(parts.minute);
}
export function taskRisk(
  task: {
    state: string;
    assignedToPersonId: string | null;
    dueDate: Date;
    scheduledEnd: Date | null;
    property: { timezone: string };
  },
  now: Date,
  riskMinutes: number,
) {
  if (terminalTaskStates.includes(task.state)) return "CLEAR";
  const deadline =
    task.scheduledEnd ??
    propertyInstant(
      new Date(task.dueDate.getTime() + 86400000).toISOString().slice(0, 10),
      0,
      task.property.timezone,
    );
  if (deadline < now) return "OVERDUE";
  if (
    task.state === "BLOCKED" ||
    (!task.assignedToPersonId &&
      deadline.getTime() - now.getTime() <= riskMinutes * 60000)
  )
    return "AT_RISK";
  return "CLEAR";
}
export function completeChecklist(
  expected: readonly { id: string }[],
  selected: readonly string[],
) {
  const ids = new Set(selected);
  return (
    ids.size === expected.length &&
    ids.size === selected.length &&
    expected.every((item) => ids.has(item.id))
  );
}
export function taskText(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}
export type OperationFormOperation =
  | "create"
  | "transition"
  | "proxy"
  | "assign"
  | "reschedule"
  | "swap"
  | "bulk"
  | "save_view"
  | "archive_view"
  | "recurring"
  | "evidence"
  | "issue"
  | "progress"
  | "series";
export const saveTaskSeriesSchema = z
  .object({
    propertyId: z.uuid(),
    expectedVersion: z.number().int().min(0),
    definition: recurringTaskDefinitionSchema,
    cancelFuture: z.boolean(),
    reason: taskReasonSchema,
  })
  .strict();
export function parseOperationForm(
  operation: OperationFormOperation,
  form: FormData,
) {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  const common = {
    reason: text("reason"),
    idempotencyKey: text("idempotencyKey"),
  };
  const startMinute = () => {
    const time = z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/u)
      .parse(text("startTime"));
    return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  };
  switch (operation) {
    case "series":
      return saveTaskSeriesSchema.parse({
        propertyId: text("propertyId"),
        expectedVersion: Number(text("expectedVersion")),
        reason: common.reason,
        cancelFuture: form.has("cancelFuture"),
        definition: {
          key: text("seriesKey"),
          type: text("type"),
          title: { en: text("titleEn"), fr: text("titleFr") },
          checklist_template_key: text("checklistTemplateKey"),
          starts_on: text("startsOn"),
          ends_on: text("endsOn") || null,
          every_days: Number(text("everyDays")),
          weekdays: form.getAll("weekdays").map((v) => Number(v)),
          start_minute: startMinute(),
          priority: text("priority"),
          enabled: form.has("enabled"),
        },
      });
    case "progress":
      return progressInputSchema.parse({
        taskId: text("taskId"),
        idempotencyKey: common.idempotencyKey,
        checklistItemIds: form.getAll("checklistItemIds"),
      });
    case "evidence": {
      const file = form.get("file") as File | null;
      return evidenceInputSchema.parse({
        taskId: text("taskId"),
        note: common.reason,
        idempotencyKey: common.idempotencyKey,
        ...(file?.size ? { contentType: file.type } : {}),
      });
    }
    case "issue":
      return issueInputSchema.parse({
        taskId: text("taskId"),
        title: text("title"),
        description: common.reason,
        severity: text("severity"),
        idempotencyKey: common.idempotencyKey,
      });
    case "bulk":
      return bulkTaskSchema.parse({
        ...common,
        items: form.getAll("items").map((v) => {
          const [taskId, version] = typeof v === "string" ? v.split(":") : [];
          return { taskId, expectedVersion: Number(version) };
        }),
        action: text("bulkAction"),
        personId: text("personId") || null,
        dueDate: text("dueDate") || undefined,
        priority: text("priority") || undefined,
        startMinute: text("startTime") ? startMinute() : undefined,
      });
    case "save_view": {
      let value: unknown;
      try {
        value = JSON.parse(text("filters"));
      } catch {
        value = undefined;
      }
      return z
        .object({
          name: z.string().trim().min(1).max(80),
          filters: taskQuerySchema,
        })
        .strict()
        .parse({ name: text("name"), filters: value });
    }
    case "archive_view":
      return z.object({ id: z.uuid() }).parse({ id: text("id") });
    case "recurring":
      return z
        .object({
          propertyId: z.uuid(),
          from: stayDateSchema,
          until: stayDateSchema,
        })
        .parse({
          propertyId: text("propertyId"),
          from: text("from"),
          until: text("until"),
        });
    case "assign":
      return assignmentCommandSchema.parse({
        ...common,
        taskId: text("taskId"),
        expectedVersion: Number(text("expectedVersion")),
        personId: text("personId") || null,
        startMinute: startMinute(),
      });
    case "reschedule":
      return rescheduleTaskSchema.parse({
        ...common,
        taskId: text("taskId"),
        expectedVersion: Number(text("expectedVersion")),
        dueDate: text("dueDate"),
        startMinute: startMinute(),
      });
    case "swap":
      return swapTaskSchema.parse({
        ...common,
        taskId: text("taskId"),
        otherTaskId: text("otherTaskId"),
        expectedVersion: Number(text("expectedVersion")),
        otherVersion: Number(text("otherVersion")),
      });
    case "create":
      return createTaskSchema.parse({
        ...common,
        propertyId: text("propertyId"),
        type: text("type"),
        title: { en: text("titleEn"), fr: text("titleFr") },
        dueDate: text("dueDate"),
        priority: text("priority"),
        checklistTemplateKey: text("checklistTemplateKey"),
      });
    case "transition":
      return taskCommandSchema.parse({
        ...common,
        taskId: text("taskId"),
        expectedVersion: Number(text("expectedVersion")),
        state: text("state"),
      });
    case "proxy":
      return proxyCompleteTaskSchema.parse({
        ...common,
        taskId: text("taskId"),
        expectedVersion: Number(text("expectedVersion")),
        performedByPersonId: text("performedByPersonId"),
        checklistItemIds: form.getAll("checklistItemIds"),
      });
    default:
      throw new Error("Invalid operation");
  }
}
