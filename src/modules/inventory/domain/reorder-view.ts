import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {inventoryStockPageSchema,inventoryStockRowSchema,inventoryStockLevelSchema} from "./stock-levels";
const quantity=inventoryStockLevelSchema.shape.available;
export const inventoryReorderMinimumViewSchema=z.object({ruleId:z.uuid(),version:z.number().int().positive(),basis:z.enum(["PHYSICAL","AVAILABLE"]),minimum:quantity,target:quantity,current:quantity,suggestedQuantity:quantity,belowMinimum:z.boolean()}).strict();
export const inventoryReorderPageSchema=inventoryStockPageSchema.extend({items:z.array(inventoryStockRowSchema.extend({minimum:inventoryReorderMinimumViewSchema.nullable(),latestSuggestion:z.object({id:z.uuid(),title:localizedTextSchema,quantity,createdAt:z.iso.datetime()}).strict().nullable()}).strict()).max(50)}).strict();
export type InventoryReorderPage=z.infer<typeof inventoryReorderPageSchema>;
