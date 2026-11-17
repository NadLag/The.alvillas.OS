import {z} from "zod";
import {stockQuantitySchema} from "./stocktake";
import {inventoryItemReasonSchema} from "./item-catalog";
const id=z.uuid().transform(value=>value.toLowerCase()),hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const inventoryPurchaseExpenseSourceSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("EXPENSE"),id,receiptId:id,receiptSource:z.enum(["DOCUMENT_VERSION","FINANCIAL_ATTACHMENT"])}).strict(),
 z.object({kind:z.literal("SUPPLIER_INVOICE_LINE"),id,receiptId:id,receiptSource:z.literal("FINANCIAL_ATTACHMENT")}).strict()
]);
export type InventoryPurchaseExpenseSource=z.infer<typeof inventoryPurchaseExpenseSourceSchema>;
export const inventoryPurchaseLineSchema=z.object({itemId:id,locationId:id,quantity:stockQuantitySchema.pipe(z.string().refine(value=>BigInt(value)>0n))}).strict();
export const inventoryPurchaseDraftSchema=z.object({source:inventoryPurchaseExpenseSourceSchema,lines:z.array(inventoryPurchaseLineSchema).min(1).max(50),reason:inventoryItemReasonSchema}).strict().superRefine((value,context)=>{
 if(new Set(value.lines.map(line=>line.locationId+":"+line.itemId)).size!==value.lines.length)context.addIssue({code:"custom",path:["lines"],message:"Each original inventory stream appears once in a receiving command"});
});
export type InventoryPurchaseDraft=z.infer<typeof inventoryPurchaseDraftSchema>;
export const inventoryPurchaseCommandSchema=z.object({draft:inventoryPurchaseDraftSchema,reviewFingerprint:hash,idempotencyKey:id}).strict();
/** Goods receiving keeps exact native counting units. Invoice monetary values
 * and allocations stay in their original financial engine; no unit conversion
 * or cost allocation is inferred from physical quantities. */
export function canonicalInventoryPurchaseLines(raw:unknown){return z.array(inventoryPurchaseLineSchema).min(1).max(50).parse(raw).toSorted((a,b)=>a.itemId.localeCompare(b.itemId)||a.locationId.localeCompare(b.locationId));}
