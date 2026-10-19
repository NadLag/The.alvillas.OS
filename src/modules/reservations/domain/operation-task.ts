import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { taskTypeSchema } from "@/platform/config/rule-registry";
import { stayDateSchema } from "./reservation";

export const taskStates = ["PLANNED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "SKIPPED", "CANCELLED", "BLOCKED"] as const;
export const taskStateSchema = z.enum(taskStates);
export const taskPriorities = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const terminalTaskStates: readonly string[] = ["COMPLETED", "CANCELLED", "SKIPPED"];
const transitions: Record<string, readonly string[]> = {
  PLANNED: ["ASSIGNED", "SKIPPED", "CANCELLED", "BLOCKED"],
  ASSIGNED: ["IN_PROGRESS", "SKIPPED", "CANCELLED", "BLOCKED"],
  IN_PROGRESS: ["COMPLETED", "SKIPPED", "CANCELLED", "BLOCKED"],
  BLOCKED: ["PLANNED", "ASSIGNED", "SKIPPED", "CANCELLED"],
  COMPLETED: [], SKIPPED: [], CANCELLED: []
};
export function canTransitionTask(from: string, to: string) { return transitions[from]?.includes(to) ?? false; }
export const taskReasonSchema = z.string().trim().min(6).max(1000);
export const createTaskSchema = z.object({
  propertyId: z.string().uuid(), type: taskTypeSchema,
  title: localizedTextSchema, dueDate: stayDateSchema,
  priority: z.enum(taskPriorities), checklistTemplateKey: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().uuid(), reason: taskReasonSchema
}).strict();
export const taskCommandSchema = z.object({
  taskId: z.string().uuid(), expectedVersion: z.number().int().min(1),
  state: taskStateSchema, reason: taskReasonSchema, idempotencyKey: z.string().uuid()
}).strict();
export const proxyCompleteTaskSchema = z.object({
  taskId: z.string().uuid(), expectedVersion: z.number().int().min(1),
  performedByPersonId: z.string().uuid(), checklistItemIds: z.array(z.string().uuid()).min(1).max(50),
  reason: taskReasonSchema, idempotencyKey: z.string().uuid()
}).strict();
export function completeChecklist(expected: readonly { id: string }[], selected: readonly string[]) {
  const ids = new Set(selected);
  return ids.size === expected.length && ids.size === selected.length && expected.every(item => ids.has(item.id));
}
export function taskText(value: unknown): Record<string, string> {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
}
export function parseOperationForm(operation: "create" | "transition" | "proxy", form: FormData) {
  const text = (key: string) => { const value = form.get(key); return typeof value === "string" ? value : ""; };
  const common = { reason: text("reason"), idempotencyKey: text("idempotencyKey") };
  switch (operation) {
    case "create": return createTaskSchema.parse({ ...common, propertyId: text("propertyId"), type: text("type"), title: { en: text("titleEn"), fr: text("titleFr") }, dueDate: text("dueDate"), priority: text("priority"), checklistTemplateKey: text("checklistTemplateKey") });
    case "transition": return taskCommandSchema.parse({ ...common, taskId: text("taskId"), expectedVersion: Number(text("expectedVersion")), state: text("state") });
    case "proxy": return proxyCompleteTaskSchema.parse({ ...common, taskId: text("taskId"), expectedVersion: Number(text("expectedVersion")), performedByPersonId: text("performedByPersonId"), checklistItemIds: form.getAll("checklistItemIds") });
    default: throw new Error("Invalid operation");
  }
}
