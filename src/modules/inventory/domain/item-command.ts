import {z} from "zod";
import {inventoryItemDraftSchema,inventoryItemReasonSchema} from "./item-catalog";
const fingerprint=z.string().regex(/^[a-f0-9]{64}$/u);
export const inventoryItemChangeSchema=z.discriminatedUnion("operation",[
 z.object({operation:z.literal("CREATE"),entry:inventoryItemDraftSchema,reason:inventoryItemReasonSchema}).strict(),
 z.object({operation:z.literal("RENAME"),id:z.uuid(),entry:inventoryItemDraftSchema,reason:inventoryItemReasonSchema}).strict(),
 z.object({operation:z.enum(["ARCHIVE","RESTORE"]),id:z.uuid(),reason:inventoryItemReasonSchema}).strict()
]);
export const inventoryItemCommandSchema=z.object({draft:inventoryItemChangeSchema,reviewFingerprint:fingerprint,idempotencyKey:z.uuid()}).strict();
export const inventoryItemReceiptSchema=z.object({schemaVersion:z.literal(1),organizationId:z.uuid(),actorId:z.uuid(),itemId:z.uuid(),operation:z.enum(["CREATE","RENAME","ARCHIVE","RESTORE"]),commandHash:fingerprint,fingerprint}).strict();
export const inventoryItemChanged="inventory.item.changed";
export const inventoryItemCancelled="inventory.item.cancelled";
export const inventoryItemCancellationSchema=z.object({schemaVersion:z.literal(1),organizationId:z.uuid(),actorId:z.uuid(),idempotencyKey:z.uuid()}).strict();
