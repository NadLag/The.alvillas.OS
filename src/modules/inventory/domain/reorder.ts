import type {z} from "zod";
import {inventoryMinimumEntrySchema,inventoryMinimumsSchema} from "@/platform/config/inventory-policy";
import {inventoryStockAvailability,type InventoryMovementPosition} from "./movement";
export type InventoryMinimumEntry=z.infer<typeof inventoryMinimumEntrySchema>;
/** Existing rules continue to compare physical counts. Available-stock basis
 * and target quantities apply only when explicitly configured for that item. */
export function inventoryReorderRecommendation(raw:unknown,position:InventoryMovementPosition){
 const minimum=inventoryMinimumEntrySchema.parse(raw),stock=inventoryStockAvailability(position),basis=minimum.reorder?.basis??"PHYSICAL",current=BigInt(basis==="PHYSICAL"?stock.quantity:stock.available),threshold=BigInt(minimum.quantity),target=BigInt(minimum.reorder?.target??minimum.quantity),belowMinimum=current<threshold;
 return{item:minimum.item,basis,minimum:threshold.toString(),target:target.toString(),current:current.toString(),belowMinimum,suggestedQuantity:belowMinimum?(target-current).toString():"0"};
}
export function inventoryMinimumsForLocation(raw:unknown,locationId:string){
 const policy=inventoryMinimumsSchema.parse(raw);return policy.location_overrides?.find(location=>location.location_id===locationId)?.minimums??policy.minimums;
}
