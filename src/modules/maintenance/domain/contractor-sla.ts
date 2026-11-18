import { z } from "zod";
import type { MaintenanceSlaPolicy } from "@/platform/config/maintenance-sla-policy";

const id = z.uuid();
export const maintenanceContractorChangeSchema = z.object({
  taskId: id,
  contractorId: id.nullable(),
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: id,
  reason: z.string().trim().min(6).max(1000)
}).strict();
export const contractorPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);
export const contractorSearchSchema = z.object({
  taskId: id,
  query: z.string().trim().min(2).max(120),
  cursor: z.string().max(6000).optional()
}).strict();

export function maintenanceSlaDeadlines(assignedAt: Date, policy: MaintenanceSlaPolicy,
  priority: z.infer<typeof contractorPrioritySchema>) {
  const rule = policy.priorities[priority];
  return {
    responseDueAt: new Date(assignedAt.getTime() + rule.response_minutes * 60000),
    completionDueAt: new Date(assignedAt.getTime() + rule.completion_minutes * 60000)
  };
}

export function maintenanceSlaMilestone(dueAt: Date, reachedAt: Date | null, now: Date, cancelled: boolean) {
  if (reachedAt) return reachedAt <= dueAt ? "MET" as const : "BREACHED" as const;
  if (now > dueAt) return "BREACHED" as const;
  return cancelled ? "CANCELLED" as const : "PENDING" as const;
}

export const contractorChoiceSchema = z.object({ id, label: z.string() });
export const contractorChoicesSchema = z.object({
  authorizationStamp: z.string(), items: z.array(contractorChoiceSchema), next: z.string().nullable()
});
const milestoneSchema = z.object({
  dueAt: z.iso.datetime(), reachedAt: z.iso.datetime().nullable(),
  state: z.enum(["MET", "BREACHED", "CANCELLED", "PENDING"])
});
const contractorHistoryEntrySchema = z.union([
  z.object({ state: z.literal("MASKED") }),
  z.object({ state: z.literal("CLEARED"), revision: z.number().int().positive(), at: z.iso.datetime() }),
  z.object({ state: z.literal("ASSIGNED"), revision: z.number().int().positive(), contractor: contractorChoiceSchema,
    reason: z.string(), at: z.iso.datetime(), priority: contractorPrioritySchema, response: milestoneSchema, completion: milestoneSchema })
]);
export const contractorWorkspaceSchema = z.object({
  authorizationStamp: z.string(), timeZone: z.string().min(1), canAssign: z.boolean(), canClear: z.boolean(), canChange: z.boolean(), policyAvailable: z.boolean(),
  revision: z.number().int().nonnegative(), current: contractorHistoryEntrySchema.nullable(),
  history: z.array(contractorHistoryEntrySchema), next: z.string().nullable()
});
