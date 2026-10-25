import { z } from "zod";
import { fieldPolicyMinutesSchema } from "./field-device-policy";
import type { ResolvedConfigRule } from "./config-rule-repository";

export const fieldUploadLifecycleKey = "field.upload_lifecycle";
export const fieldUploadLifecycleSchema = z.object({ openUploadIdleAfterMinutes: fieldPolicyMinutesSchema }).strict();
export const fieldUploadLifecycleSnapshotSchema = fieldUploadLifecycleSchema.extend({ configRuleId: z.uuid(), configVersion: z.number().int().positive() }).strict();
export type FieldUploadLifecycleSnapshot = z.infer<typeof fieldUploadLifecycleSnapshotSchema>;
export function fieldUploadLifecycleSnapshot(rule: Pick<ResolvedConfigRule, "id" | "key" | "version" | "parsedValue"> | null): FieldUploadLifecycleSnapshot | null {
  if (!rule) return null;
  if (rule.key !== fieldUploadLifecycleKey) throw Error("Unexpected field upload lifecycle policy key");
  return fieldUploadLifecycleSnapshotSchema.parse({ ...fieldUploadLifecycleSchema.parse(rule.parsedValue), configRuleId: rule.id, configVersion: rule.version });
}
