import {z} from "zod";
import {inventoryItemReasonSchema,assertInventoryItemCanRetire} from "./item-catalog";
import {InventoryCatalogDefinitionError} from "./catalog-errors";
export const inventoryLocationKindSchema=z.enum(["PROPERTY","STORE","LAUNDRY","IN_TRANSIT"]);
export const inventoryLocationEntrySchema=z.object({kind:inventoryLocationKindSchema,propertyId:z.uuid().nullable(),label:z.string().trim().min(1).max(240)}).strict().refine(value=>(value.kind==="PROPERTY")===(value.propertyId!==null));
export function inventoryLocationDefinition(raw:unknown,original?:{kind:string;propertyId:string|null}){
 const value=inventoryLocationEntrySchema.parse(raw);if(original&&(value.kind!==original.kind||value.propertyId!==original.propertyId))throw new InventoryCatalogDefinitionError();return value;
}
export const assertInventoryLocationCanRetire=assertInventoryItemCanRetire;
export const inventoryLocationSelectionSchema=z.object({query:z.string().trim().max(100).default(""),kind:inventoryLocationKindSchema.optional(),propertyId:z.uuid().optional(),archived:z.boolean().default(false),after:z.uuid().optional()}).strict();
const fingerprint=z.string().regex(/^[a-f0-9]{64}$/u),operation=z.enum(["CREATE","RENAME","ARCHIVE","RESTORE"]);
export const inventoryLocationChangeSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("CREATE"),entry:inventoryLocationEntrySchema,reason:inventoryItemReasonSchema}).strict(),
 z.object({operation:z.literal("RENAME"),id:z.uuid(),entry:inventoryLocationEntrySchema,reason:inventoryItemReasonSchema}).strict(),
 z.object({operation:z.enum(["ARCHIVE","RESTORE"]),id:z.uuid(),reason:inventoryItemReasonSchema}).strict()
]);
export const inventoryLocationCommandSchema=z.object({draft:inventoryLocationChangeSchema,reviewFingerprint:fingerprint,idempotencyKey:z.uuid()}).strict();
export const inventoryLocationReceiptSchema=z.object({schemaVersion:z.literal(1),organizationId:z.uuid(),actorId:z.uuid(),locationId:z.uuid(),operation,commandHash:fingerprint,fingerprint}).strict();
export const inventoryLocationCancelled="inventory.location.cancelled",inventoryLocationChanged="inventory.location.changed";
