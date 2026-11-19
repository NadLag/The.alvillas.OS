import { z } from "zod";
import { recurringTaskDefinitionSchema } from "@/platform/config/operation-policy";

export const assetPreventivePrefix = "asset-preventive-";
export const assetPreventiveKey = (id: string) => assetPreventivePrefix + id;
export const preventiveScheduleSchema = z.object({
  assetId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  definition: z.strictObject(recurringTaskDefinitionSchema.shape).omit({ key: true, type: true }),
  reason: z.string().trim().min(6).max(500),
  cancelFuture: z.boolean()
}).strict();
