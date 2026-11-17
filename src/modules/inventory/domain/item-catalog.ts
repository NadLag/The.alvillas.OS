import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {configSlugSchema} from "@/platform/config/identifiers";
import {inventoryCategorySchema} from "@/platform/config/inventory-policy";
import {stockQuantitySchema} from "./stocktake";

/** EQUIPMENT is the existing canonical category for long-life physical assets.
 * Item identity and units remain independent of property minimum/usage rules. */
export const inventoryItemDraftSchema=z.object({
 key:configSlugSchema,name:localizedTextSchema,category:inventoryCategorySchema,
 unit:z.string().trim().min(1).max(60).nullable()
}).strict();
export const inventoryItemReasonSchema=z.string().trim().min(6).max(500);
export const inventoryItemSelectionSchema=z.object({
 query:z.string().trim().max(100).default(""),category:inventoryCategorySchema.optional(),
 archived:z.boolean().default(false),after:configSlugSchema.optional()
}).strict();
export type InventoryItemDefinition=z.infer<typeof inventoryItemDraftSchema>;
export class InventoryItemAccessError extends Error{}
export class InventoryItemConflictError extends Error{}
export class InventoryItemDefinitionError extends Error{}
export class InventoryItemStockHeldError extends Error{}

/** The original SKU, category and unit define an immutable quantity stream.
 * Renaming a label never converts or reclassifies its original movements. */
export function inventoryItemDefinition(raw:unknown,existing?:Pick<InventoryItemDefinition,"key"|"unit"|"category">){
 const value=inventoryItemDraftSchema.parse(raw);
 if(existing&&(value.key!==existing.key||value.unit!==existing.unit||value.category!==existing.category))throw new InventoryItemDefinitionError("Create another SKU for a different category or unit");
 if(!existing&&value.unit===null)throw new InventoryItemDefinitionError("An explicit original item unit is required");
 return value;
}

/** Inspect each actual location independently: opposite amounts at different
 * locations never mean that physical stock has disappeared. */
export function assertInventoryItemCanRetire(positions:readonly{quantity:string}[]){
 if(positions.some(row=>BigInt(stockQuantitySchema.parse(row.quantity))!==0n))throw new InventoryItemStockHeldError("Reconcile or dispose of actual remaining stock before retiring its item");
}

export function selectInventoryItems<Row extends{key:string;category:z.infer<typeof inventoryCategorySchema>;name:Record<string,string|undefined>;unit:string|null;archivedAt:Date|null}>(rows:readonly Row[],raw:unknown){
 const input=inventoryItemSelectionSchema.parse(raw),query=input.query.toLowerCase();
 const items=rows.filter(row=>Boolean(row.archivedAt)===input.archived&&(!input.category||row.category===input.category)&&(!input.after||row.key>input.after)&&(!query||[row.key,row.unit,...Object.values(row.name)].some(value=>value?.toLowerCase().includes(query)))).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 return{items:items.slice(0,50),next:items.length>50?items[49].key:null};
}
