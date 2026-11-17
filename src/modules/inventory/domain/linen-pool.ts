import {z} from "zod";
import {inventoryLinenSetSchema} from "@/platform/config/inventory-policy";
import {stockQuantitySchema} from "./stocktake";
import {inventoryStockAvailability,type InventoryMovementPosition} from "./movement";
export type LinenPoolComponent={key:string;category:string;unit:string|null;retired:boolean;position:InventoryMovementPosition};
/** A complete set is limited by its scarcest original component. Components
 * retain their own catalog units; the forecast never creates a movement. */
export function inventoryLinenSetAvailability(raw:unknown,components:readonly LinenPoolComponent[]){
 const set=inventoryLinenSetSchema.parse(raw),byKey=new Map(components.map(component=>[component.key,component])),lines=set.components.map(component=>{const original=byKey.get(component.item);if(!original||original.retired||original.category!=="LINEN"||!original.unit)return{item:component.item,perSet:BigInt(component.quantity).toString(),available:null,completeSets:null};const quantity=inventoryStockAvailability(original.position).available,available=BigInt(stockQuantitySchema.parse(quantity)),completeSets=(available>0n?available:0n)/BigInt(component.quantity);return{item:component.item,perSet:BigInt(component.quantity).toString(),available:quantity,completeSets:completeSets.toString()};});
 const counts=lines.map(line=>line.completeSets===null?null:BigInt(line.completeSets)),availableSets=counts.some(value=>value===null)?null:counts.reduce<bigint|null>((minimum,value)=>value===null?minimum:minimum===null||value<minimum?value:minimum,null);
 return{key:set.key,name:set.name,description:set.description??null,availableSets:availableSets?.toString()??null,components:lines};
}
export const linenPoolQuantitySchema=z.string().regex(/^(?:0|-?[1-9]\d{0,64})$/u);
