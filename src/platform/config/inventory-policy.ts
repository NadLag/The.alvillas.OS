import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { configSlugSchema } from "./identifiers";

export const inventoryMinimumsKey = "inventory.minimums";
export const inventoryMaximumItems = 200;
export const inventoryCategorySchema = z.enum(["CONSUMABLE", "LINEN", "EQUIPMENT"]);

export const inventoryMinimumsSchema = z
  .object({
    minimums: z.array(
      z
        .object({
          item: configSlugSchema,
          quantity: z.number().int().min(0),
          name: localizedTextSchema.optional(),
          unit: z.string().trim().min(1).max(60).optional(),
          category: inventoryCategorySchema.optional(),
          expected_per_stay: z.number().int().min(0).optional()
        })
        .passthrough()
    ).max(inventoryMaximumItems).refine(v => new Set(v.map(i => i.item)).size === v.length, "Inventory item keys must be unique")
  })
  .passthrough();
