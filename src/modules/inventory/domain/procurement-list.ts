import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {inventoryMaximumItems} from "@/platform/config/inventory-policy";
import {configSlugSchema} from "@/platform/config/identifiers";
import {inventoryReorderMinimumViewSchema} from "./reorder-view";
export const inventoryProcurementSelectionSchema=z.object({locationId:z.uuid(),query:z.string().trim().max(100).default("")}).strict();
export const inventoryProcurementListSchema=z.object({selection:inventoryProcurementSelectionSchema,location:z.object({id:z.uuid(),label:z.string(),propertyName:z.string().nullable()}).strict(),policy:z.object({id:z.uuid(),version:z.number().int().positive()}).strict().nullable(),items:z.array(z.object({key:configSlugSchema,itemId:z.uuid().nullable(),name:localizedTextSchema,unit:z.string().nullable(),condition:z.enum(["READY","MISSING","RETIRED","INCOMPATIBLE"]),requirement:inventoryReorderMinimumViewSchema.nullable()}).strict()).max(inventoryMaximumItems),canExport:z.boolean(),observedAt:z.iso.datetime()}).strict();
export type InventoryProcurementList=z.infer<typeof inventoryProcurementListSchema>;
/** Quote every original value and prevent spreadsheet formula execution. */
export function inventoryProcurementCsv(rows:readonly(readonly string[])[]){return "\uFEFF"+rows.map(row=>row.map(value=>'"'+(/^[\s\uFEFF]*[=+@-]/u.test(value)?"'"+value:value).replaceAll('"','""')+'"').join(",")).join("\r\n")+"\r\n";}
