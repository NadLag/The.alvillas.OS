import {z} from "zod";
import {configSlugSchema} from "@/platform/config/identifiers";
import {inventoryCategorySchema} from "@/platform/config/inventory-policy";
import {inventoryMovementPositionSchema} from "./movement";
import {inventoryLocationKindSchema} from "./location-catalog";
const integer=z.string().regex(/^(?:0|-?[1-9]\d{0,64})$/u),positive=integer.pipe(z.string().refine(value=>BigInt(value)>0n));
export const inventoryReorderSignalSchema=z.object({
 schemaVersion:z.literal(1),organizationId:z.uuid(),actorId:z.uuid(),
 item:z.object({id:z.uuid(),key:configSlugSchema,category:inventoryCategorySchema,unit:z.string().nullable()}).strict(),
 location:z.object({id:z.uuid(),kind:inventoryLocationKindSchema,propertyId:z.uuid().nullable()}).strict(),
 source:z.object({kind:z.enum(["MOVEMENT","STOCKTAKE","CONFIGURATION"]),id:z.uuid()}).strict(),
 position:inventoryMovementPositionSchema,
 minimumRule:z.object({id:z.uuid(),version:z.number().int().positive()}).strict(),
 basis:z.enum(["PHYSICAL","AVAILABLE"]),minimum:integer,target:integer,current:integer,suggestedQuantity:positive,
 timezone:z.string().min(1).max(120)
}).strict();
export type InventoryReorderSignal=z.infer<typeof inventoryReorderSignalSchema>;
export const inventoryReorderSignalKey=(signal:InventoryReorderSignal)=>`inventory-below-minimum:${signal.location.id}:${signal.item.id}:${signal.position.revision}:${signal.minimumRule.id}`;
