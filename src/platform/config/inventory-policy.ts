import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { configSlugSchema } from "./identifiers";

export const inventoryMinimumsKey = "inventory.minimums";
export const inventoryMaximumItems = 200;
export const inventoryCategorySchema = z.enum(["CONSUMABLE", "LINEN", "EQUIPMENT"]);
export const inventoryMinimumEntrySchema=z.object({
  item:configSlugSchema,quantity:z.number().int().min(0),name:localizedTextSchema.optional(),
  unit:z.string().trim().min(1).max(60).optional(),category:inventoryCategorySchema.optional(),
  expected_per_stay:z.number().int().min(0).optional(),
  reorder:z.object({basis:z.enum(["PHYSICAL","AVAILABLE"]),target:z.number().int().min(0).optional()}).strict().optional()
}).passthrough().superRefine((value,context)=>{if(value.reorder?.target!==undefined&&value.reorder.target<value.quantity)context.addIssue({code:"custom",path:["reorder","target"],message:"Reorder target must cover the configured minimum"});});
const minimums=z.array(inventoryMinimumEntrySchema).max(inventoryMaximumItems).refine(value=>new Set(value.map(item=>item.item)).size===value.length,"Inventory item keys must be unique");

export const inventoryMinimumsSchema = z
  .object({
    minimums,
    location_overrides:z.array(z.object({location_id:z.uuid(),minimums}).passthrough()).max(1000).refine(value=>new Set(value.map(location=>location.location_id)).size===value.length,"Inventory location overrides must be unique").optional()
  })
  .passthrough();
