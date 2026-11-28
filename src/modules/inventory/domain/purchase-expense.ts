import {z} from "zod";
import {stockQuantitySchema} from "./stocktake";
import {inventoryItemReasonSchema} from "./item-catalog";
import {inventoryMovementReceiptSchema} from "./movement-command";
import {inventoryMovementPreviewSchema} from "./movement-view";
export const inventoryPurchaseMaximumLines=50;
const id=z.uuid().transform(value=>value.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const inventoryPurchaseEntrySchema=z.object({kind:z.enum(["EXPENSE","SUPPLIER_INVOICE_LINE"]),id}).strict();
export const inventoryPurchaseReceiptChoicesSchema=z.object({originId:id,reference:z.string(),amount:z.object({amount:z.string(),currency:z.string()}).strict(),items:z.array(z.object({id,label:z.string(),receiptSource:z.enum(["DOCUMENT_VERSION","FINANCIAL_ATTACHMENT"])}).strict()).max(31),next:id.nullable()}).strict();
export const inventoryPurchaseContextSchema=inventoryPurchaseReceiptChoicesSchema.extend({entry:inventoryPurchaseEntrySchema,canReceive:z.boolean(),existing:z.object({idempotencyKey:id,receivedAt:z.iso.datetime(),movementGroupIds:z.array(id).min(1).max(inventoryPurchaseMaximumLines)}).strict().nullable()}).strict();
export const inventoryPurchaseExpenseSourceSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("EXPENSE"),id,receiptId:id,receiptSource:z.enum(["DOCUMENT_VERSION","FINANCIAL_ATTACHMENT"])}).strict(),
 z.object({kind:z.literal("SUPPLIER_INVOICE_LINE"),id,receiptId:id,receiptSource:z.literal("FINANCIAL_ATTACHMENT")}).strict()
]);
export type InventoryPurchaseExpenseSource=z.infer<typeof inventoryPurchaseExpenseSourceSchema>;
export const inventoryPurchaseLineSchema=z.object({itemId:id,locationId:id,quantity:stockQuantitySchema.pipe(z.string().refine(value=>BigInt(value)>0n))}).strict();
export const inventoryPurchaseDraftSchema=z.object({source:inventoryPurchaseExpenseSourceSchema,lines:z.array(inventoryPurchaseLineSchema).min(1).max(inventoryPurchaseMaximumLines),reason:inventoryItemReasonSchema}).strict().superRefine((value,context)=>{
 if(new Set(value.lines.map(line=>line.locationId+":"+line.itemId)).size!==value.lines.length)context.addIssue({code:"custom",path:["lines"],message:"Each original inventory stream appears once in a receiving command"});
});
export type InventoryPurchaseDraft=z.infer<typeof inventoryPurchaseDraftSchema>;

export const inventoryPurchaseCommandSchema=z.object({draft:inventoryPurchaseDraftSchema,reviewFingerprint:hash,idempotencyKey:id}).strict();
export const inventoryPurchaseProofSchema=z.object({kind:inventoryPurchaseExpenseSourceSchema.options[0].shape.kind.or(inventoryPurchaseExpenseSourceSchema.options[1].shape.kind),id,rootId:id,transactionId:id,propertyId:id.nullable(),reservationId:id.nullable(),reference:z.string(),amount:z.object({amount:z.string(),currency:z.string()}).passthrough(),supplierId:id.nullable(),purchaserId:id.nullable(),fundingKind:z.enum(["COMPANY","PERSONAL"]).nullable(),receiptId:id,receiptSource:z.enum(["DOCUMENT_VERSION","FINANCIAL_ATTACHMENT"]),receiptSha256:hash,fingerprint:hash}).strict();
export const inventoryPurchaseReceiptSchema=z.object({schemaVersion:z.literal(1),organizationId:id,actorId:id,idempotencyKey:id,draft:inventoryPurchaseDraftSchema,reviewFingerprint:hash,source:inventoryPurchaseProofSchema,movements:z.array(inventoryMovementReceiptSchema).min(1).max(inventoryPurchaseMaximumLines),receivedAt:z.iso.datetime()}).strict();
export const inventoryPurchasePublishSchema=inventoryPurchaseReceiptSchema.extend({replayed:z.boolean()}).strict();
export const inventoryPurchaseRecoverySchema=z.discriminatedUnion("recorded",[z.object({recorded:z.literal(true),receipt:inventoryPurchaseReceiptSchema}).strict(),z.object({recorded:z.literal(false),receipt:z.null()}).strict()]);
export const inventoryPurchaseReviewSchema=z.object({draft:inventoryPurchaseDraftSchema,reviewFingerprint:hash,source:inventoryPurchaseProofSchema,lines:z.array(inventoryMovementPreviewSchema).min(1).max(inventoryPurchaseMaximumLines)}).strict();
export const inventoryPurchaseReceived="inventory.purchase.received",inventoryPurchaseSourceReceived="inventory.purchase.source_received",inventoryPurchaseCancelled="inventory.purchase.cancelled";
export const inventoryPurchaseReceiptKey=(nonce:string)=>"inventory-purchase:"+nonce;
export const inventoryPurchaseSourceKey=(kind:string,rootId:string)=>"inventory-purchase-source:"+kind+":"+rootId;
/** Goods receiving keeps exact native counting units. Invoice monetary values
 * and allocations stay in their original financial engine; no unit conversion
 * or cost allocation is inferred from physical quantities. */
export function canonicalInventoryPurchaseLines(raw:unknown){return z.array(inventoryPurchaseLineSchema).min(1).max(inventoryPurchaseMaximumLines).parse(raw).slice().sort((a,b)=>a.itemId.localeCompare(b.itemId)||a.locationId.localeCompare(b.locationId));}
export type InventoryPurchaseEntry=z.infer<typeof inventoryPurchaseEntrySchema>;
export type InventoryPurchaseContext=z.infer<typeof inventoryPurchaseContextSchema>;
export type InventoryPurchaseReview=z.infer<typeof inventoryPurchaseReviewSchema>;
