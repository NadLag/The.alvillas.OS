import { z } from "zod";
import type { ResolvedConfigRule } from "./config-rule-repository";

export const fieldDevicePolicyKey = "field.device_hygiene";
export const fieldDevicePolicySchema = z.object({
  queueWarningAfterMinutes: z.number().int().min(0).max(Math.floor(Number.MAX_SAFE_INTEGER / 60_000)).nullable()
}).strict();
export const fieldDevicePolicySnapshotSchema = fieldDevicePolicySchema.extend({
  configRuleId: z.uuid(), configVersion: z.number().int().positive()
}).strict();
export type FieldDevicePolicySnapshot = z.infer<typeof fieldDevicePolicySnapshotSchema>;

export function fieldDevicePolicySnapshot(rule: Pick<ResolvedConfigRule, "id" | "key" | "version" | "parsedValue"> | null): FieldDevicePolicySnapshot | null {
  if (!rule) return null;
  if (rule.key !== fieldDevicePolicyKey) throw new Error("Unexpected field device policy key");
  return fieldDevicePolicySnapshotSchema.parse({ ...fieldDevicePolicySchema.parse(rule.parsedValue), configRuleId: rule.id, configVersion: rule.version });
}
