import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {inventoryCategorySchema} from "@/platform/config/inventory-policy";
import {configSlugSchema} from "@/platform/config/identifiers";
import {inventoryLocationKindSchema} from "./location-catalog";
import {inventoryMovementPositionSchema} from "./movement";
import {stockQuantitySchema} from "./stocktake";
const common={query:z.string().trim().max(100).default(""),includeRetired:z.boolean().default(false)};
export const inventoryStockSelectionSchema=z.discriminatedUnion("mode",[
 z.object({...common,mode:z.literal("LOCATION"),locationId:z.uuid(),category:inventoryCategorySchema.optional(),after:configSlugSchema.optional()}).strict(),
 z.object({...common,mode:z.literal("ITEM"),itemId:z.uuid(),kind:inventoryLocationKindSchema.optional(),after:z.uuid().optional()}).strict()
]);
export type InventoryStockSelection=z.infer<typeof inventoryStockSelectionSchema>;
export const inventoryStockLevelSchema=inventoryMovementPositionSchema.extend({available:stockQuantitySchema,shortage:stockQuantitySchema,conditionShortage:stockQuantitySchema}).strict();
const item=z.object({id:z.uuid(),key:configSlugSchema,name:localizedTextSchema,category:inventoryCategorySchema,unit:z.string().nullable(),retired:z.boolean()}).strict();
const location=z.object({id:z.uuid(),kind:inventoryLocationKindSchema,label:z.string(),propertyId:z.uuid().nullable(),propertyName:z.string().nullable(),retired:z.boolean()}).strict();
export const inventoryStockRowSchema=z.object({item,location,position:inventoryStockLevelSchema,lastMovementAt:z.iso.datetime().nullable(),lastCountAt:z.iso.datetime().nullable()}).strict();
export const inventoryStockTotalsSchema=z.object({quantity:stockQuantitySchema,reserved:stockQuantitySchema,damaged:stockQuantitySchema,available:stockQuantitySchema,shortage:stockQuantitySchema,conditionShortage:stockQuantitySchema,locationCount:z.string().regex(/^(?:0|[1-9]\d*)$/u)}).strict();
export const inventoryStockPageSchema=z.object({selection:inventoryStockSelectionSchema,source:z.discriminatedUnion("mode",[z.object({mode:z.literal("LOCATION"),location}).strict(),z.object({mode:z.literal("ITEM"),item}).strict()]),items:z.array(inventoryStockRowSchema).max(50),totals:inventoryStockTotalsSchema.nullable(),next:z.string().nullable(),observedAt:z.iso.datetime(),canRecord:z.boolean()}).strict();
export type InventoryStockPage=z.infer<typeof inventoryStockPageSchema>;
