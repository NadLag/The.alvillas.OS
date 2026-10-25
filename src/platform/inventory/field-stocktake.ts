import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { configSlugSchema } from "@/platform/config/identifiers";
import { inventoryMaximumItems } from "@/platform/config/inventory-policy";
import { countedStockQuantitySchema, stockQuantitySchema, stockRevisionSchema } from "@/modules/inventory/domain/stocktake";
export { StocktakeConflictError } from "@/modules/inventory/domain/stocktake";
export type { StockPosition } from "@/modules/inventory/domain/stocktake";

const unit = z.string().trim().min(1).max(60).nullable();
export const stockPositionSchema = z.object({ quantity: stockQuantitySchema, revision: stockRevisionSchema }).strict();
export const fieldStocktakePayloadSchema = z.object({
  taskId: z.uuid(), itemKey: configSlugSchema,
  expectedQuantity: stockQuantitySchema, expectedRevision: stockRevisionSchema,
  countedQuantity: countedStockQuantitySchema, unit,
  catalogRuleId: z.uuid(), catalogVersion: z.number().int().positive(),
  note: z.string().trim().min(1).max(1000)
}).strict();
export type FieldStocktakePayload = z.infer<typeof fieldStocktakePayloadSchema>;

export const fieldLinenItemSchema = z.object({
  key: configSlugSchema, name: localizedTextSchema, unit,
  quantity: stockQuantitySchema, revision: stockRevisionSchema,
  available: z.boolean()
}).strict();
export const fieldLinenSnapshotSchema = z.object({
  catalog: z.object({ id: z.uuid(), version: z.number().int().positive() }).strict().nullable(),
  items: z.array(fieldLinenItemSchema).max(inventoryMaximumItems)
}).strict().refine(snapshot => snapshot.catalog !== null || snapshot.items.length === 0);
export type FieldLinenSnapshot = z.infer<typeof fieldLinenSnapshotSchema>;

export class FieldStocktakeUnavailableError extends Error {
  constructor(readonly code: "CATALOG_CHANGED" | "ITEM_UNAVAILABLE" | "UNIT_CHANGED") {
    super(code);
    this.name = "FieldStocktakeUnavailableError";
  }
}
