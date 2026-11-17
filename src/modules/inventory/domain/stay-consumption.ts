import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {configSlugSchema} from "@/platform/config/identifiers";
import {inventoryMinimumEntrySchema} from "@/platform/config/inventory-policy";
const quantity=z.string().regex(/^(?:0|-?[1-9]\d{0,64})$/u);
export const inventoryStaySelectionSchema=z.object({reservationId:z.uuid(),query:z.string().trim().max(100).default(""),after:configSlugSchema.optional()}).strict();
export type InventoryStaySelection=z.infer<typeof inventoryStaySelectionSchema>;
export const inventoryStayPageSchema=z.object({selection:inventoryStaySelectionSchema,stay:z.object({id:z.uuid(),reference:z.string(),propertyId:z.uuid(),propertyName:z.string(),status:z.string(),checkIn:z.iso.date(),checkOut:z.iso.date(),timezone:z.string(),applicable:z.boolean()}).strict(),policy:z.object({id:z.uuid(),version:z.number().int().positive(),effectiveAt:z.iso.datetime()}).strict().nullable(),items:z.array(z.object({key:configSlugSchema,itemId:z.uuid().nullable(),name:localizedTextSchema,unit:z.string().nullable(),condition:z.enum(["READY","MISSING","RETIRED","INCOMPATIBLE"]),expected:quantity.nullable(),actual:quantity,variance:quantity.nullable(),movementCount:z.string().regex(/^(?:0|[1-9]\d*)$/u)}).strict()).max(50),next:configSlugSchema.nullable(),observedAt:z.iso.datetime()}).strict();
export type InventoryStayPage=z.infer<typeof inventoryStayPageSchema>;
/** A per-stay quantity is used once, in its original unit. An absent setting
 * is unknown, while an explicitly configured zero remains a real expectation. */
export function inventoryStayComparison(configured:unknown,actual:string,applicable:boolean,compatible:boolean){
 const observed=BigInt(quantity.parse(actual)),policy=configured===undefined?undefined:inventoryMinimumEntrySchema.parse(configured),expected=applicable&&compatible&&policy?.expected_per_stay!==undefined?BigInt(policy.expected_per_stay):null;
 return{expected:expected?.toString()??null,actual:observed.toString(),variance:expected===null?null:(observed-expected).toString()};
}
