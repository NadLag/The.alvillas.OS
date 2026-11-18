import {z} from "zod";
import {Money} from "@/platform/money/money";
import {InventoryCatalogAccessError,InventoryCatalogDefinitionError} from "./catalog-errors";
const id=z.uuid().transform(value=>value.toLowerCase()),amount=z.string().regex(/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/u);
export const actualLaundryInvoiceSelectionSchema=z.object({invoiceId:id,revisionId:id,lineIds:z.array(id).min(1).max(100),receiptVersionId:id}).strict().superRefine((value,context)=>{if(new Set(value.lineIds).size!==value.lineIds.length)context.addIssue({code:"custom",path:["lineIds"],message:"Each original invoice line is selected once"});});
export const actualLaundryInvoiceDraftSchema=z.object({batchId:id,expectedInvoiceId:id,selection:actualLaundryInvoiceSelectionSchema,reason:z.string().trim().min(6).max(500)}).strict();
export const actualLaundryInvoiceLinesSchema=z.array(z.object({id,propertyId:id.nullable(),reservationId:id.nullable(),category:z.string().min(1).max(120),costCenter:z.string().max(120).nullable(),amount}).strict()).min(1);
/** Select whole native invoice lines. No proration, tax interpretation, currency
 * conversion, expense recognition or supplier payment occurs in this proof. */
export function selectActualLaundryInvoiceLines(raw:unknown,selection:unknown,context:{propertyIds:readonly string[];reservationIds:readonly string[];currency:string}){
 const selected=actualLaundryInvoiceSelectionSchema.parse(selection),lines=actualLaundryInvoiceLinesSchema.parse(raw),identities=new Map(lines.map(line=>[line.id,line]));if(identities.size!==lines.length)throw new InventoryCatalogDefinitionError();const result=selected.lineIds.map(lineId=>{const line=identities.get(lineId);if(!line)throw new InventoryCatalogAccessError();if(line.propertyId?!context.propertyIds.includes(line.propertyId):context.propertyIds.length>0)throw new InventoryCatalogAccessError();if(line.reservationId&&!context.reservationIds.includes(line.reservationId))throw new InventoryCatalogAccessError();return{...line,amount:Money.of(line.amount,context.currency).toJSON().amount};}).sort((a,b)=>a.id.localeCompare(b.id));
 return{lines:result,total:result.reduce((sum,line)=>sum.add(Money.of(line.amount,context.currency)),Money.zero(context.currency)).toJSON()};
}
