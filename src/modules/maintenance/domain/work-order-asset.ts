import { z } from "zod";
const id = z.uuid();
export const changeWorkOrderAssetSchema = z.object({
  taskId: id, assetId: id.nullable(), expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: id, reason: z.string().trim().min(6).max(1000)
}).strict();
const link = z.discriminatedUnion("state", [
  z.object({ state: z.literal("MASKED") }),
  z.object({ state: z.literal("CLEARED"), number: z.number().int().positive(), at: z.iso.datetime() }),
  z.object({ state: z.literal("LINKED"), number: z.number().int().positive(), assetId: id, label: z.string(), tag: z.string(),
    at: z.iso.datetime(), reason: z.string() })
]);
export const workOrderAssetViewSchema = z.object({
  authorizationStamp: z.string(), number: z.number().int().nonnegative(), canEdit: z.boolean(),
  current: link.nullable(), items: z.array(link), next: z.number().int().positive().nullable()
});
