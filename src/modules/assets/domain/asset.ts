import { z } from "zod";

export const assetConditions = ["EXCELLENT", "GOOD", "FAIR", "POOR", "UNSERVICEABLE"] as const;
const id = z.uuid().transform(value => value.toLowerCase());
const reason = z.string().trim().min(6).max(1000);
export const assetFieldsSchema = z.object({
  name: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  condition: z.enum(assetConditions),
  purchaseOn: z.iso.date().nullable(),
  warrantyProvider: z.string().trim().min(1).max(160).nullable(),
  warrantyReference: z.string().trim().min(1).max(120).nullable(),
  warrantyStartsOn: z.iso.date().nullable(),
  warrantyEndsOn: z.iso.date().nullable(),
  usefulLifeMonths: z.number().int().positive().max(2147483647).nullable(),
  // Omitted updates retain the existing cost with its original authority.
  cost: z.object({ amount: z.string().regex(/^\d{1,16}(?:\.\d{1,2})?$/u), currency: z.string().regex(/^[A-Z]{3}$/u) }).strict().nullable().optional()
}).strict().superRefine((value, ctx) => {
  if (value.cost && !value.purchaseOn) ctx.addIssue({ code: "custom", path: ["purchaseOn"] });
  if (value.warrantyStartsOn && (!value.warrantyEndsOn || value.warrantyStartsOn > value.warrantyEndsOn))
    ctx.addIssue({ code: "custom", path: ["warrantyEndsOn"] });
});
const command = { fields: assetFieldsSchema, idempotencyKey: id, reason };
export const createAssetSchema = z.object({
  ...command, propertyId: id, tag: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u)
}).strict();
export const reviseAssetSchema = z.object({ ...command, assetId: id, expectedRevision: z.number().int().positive() }).strict();
export const assetSearchSchema = z.object({
  query: z.string().trim().max(120).default(""), propertyId: id.optional(), cursor: z.string().max(6000).optional()
}).strict();
export type AssetFields = z.infer<typeof assetFieldsSchema>;
export class AssetAccessError extends Error {}
export class AssetConflictError extends Error {}
