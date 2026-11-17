import {z} from "zod";
import {configSlugSchema} from "./identifiers";

/** Menu definitions are part of a canonical services.pricing entry. Quantity
 * strings preserve recipe precision independently of ledger money precision. */
export const chefMenuTextSchema=z.object({
 en:z.string().trim().min(1).max(240),
 fr:z.string().trim().min(1).max(240),
 ar:z.string().trim().min(1).max(240)
}).strict();
export const chefMenuQuantitySchema=z.string().trim()
 .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/u)
 .refine(value=>!/^0(?:\.0+)?$/u.test(value),"chef_menu_positive_quantity_required");
export const chefMenuIngredientSchema=z.object({
 key:configSlugSchema,name:chefMenuTextSchema,quantity:chefMenuQuantitySchema,
 unit:z.object({key:configSlugSchema,name:chefMenuTextSchema}).strict()
}).strict();
export const chefMenuSchema=z.object({
 schemaVersion:z.literal(1),
 serving_quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 serving_basis:z.literal("PER_PRICED_UNIT"),
 chef_component_key:configSlugSchema,
 ingredients:z.array(chefMenuIngredientSchema).min(1).max(100)
  .refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length,"chef_menu_unique_ingredients_required"),
 preparation:z.object({en:z.string().trim().min(1).max(4000),fr:z.string().trim().min(1).max(4000),ar:z.string().trim().min(1).max(4000)}).strict(),
 allergens:z.array(z.object({key:configSlugSchema,name:chefMenuTextSchema}).strict()).max(50)
  .refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length,"chef_menu_unique_allergens_required")
}).strict();
export type ChefMenuDefinition=z.infer<typeof chefMenuSchema>;
