import { z } from "zod";

export const disposalMethods = ["SOLD", "RECYCLED", "DONATED", "SCRAPPED", "RETURNED", "OTHER"] as const;
const common = { assetId: z.uuid(), expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.uuid(), reason: z.string().trim().min(6).max(1000) };
const amount = z.object({ amount: z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict();
export const assetLifecycleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("PLAN"), effectiveOn: z.iso.date(), budget: amount.nullable() }),
  z.strictObject({ ...common, kind: z.literal("CANCEL") }),
  z.strictObject({ ...common, kind: z.literal("REPLACE"), effectiveOn: z.iso.date(),
    successorTag: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u) }),
  z.strictObject({ ...common, kind: z.literal("DISPOSE"), effectiveOn: z.iso.date(), method: z.enum(disposalMethods),
    reference: z.string().trim().min(1).max(160).nullable() })
]);
export type AssetLifecycleCommand = z.infer<typeof assetLifecycleSchema>;
