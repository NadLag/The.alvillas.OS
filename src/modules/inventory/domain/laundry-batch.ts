import {z} from "zod";
import {stockQuantitySchema} from "./stocktake";
import {inventoryItemReasonSchema} from "./item-catalog";
import {InventoryCatalogConflictError,InventoryCatalogDefinitionError} from "./catalog-errors";
const id=z.uuid().transform(value=>value.toLowerCase());
export const laundryQuantitySchema=stockQuantitySchema.pipe(z.string().refine(value=>BigInt(value)>0n));
export const laundryBucketSchema=z.enum(["ORIGIN","OUTBOUND","OUTBOUND_DAMAGED","LAUNDRY_PENDING","CLEAN_READY","REJECTED","DAMAGED_READY","INBOUND_CLEAN","INBOUND_DAMAGED","RETURNED_CLEAN","RETURNED_DAMAGED","MISSING_OUTBOUND","MISSING_OUTBOUND_DAMAGED","MISSING_LAUNDRY_PENDING","MISSING_CLEAN_READY","MISSING_REJECTED","MISSING_DAMAGED_READY","MISSING_INBOUND_CLEAN","MISSING_INBOUND_DAMAGED","LOST_OUTBOUND","LOST_LAUNDRY","LOST_INBOUND"]);
export type LaundryBucket=z.infer<typeof laundryBucketSchema>;
export const laundryBatchDefinitionSchema=z.object({sourceLocationId:id,outboundTransitId:id,laundryLocationId:id,inboundTransitId:id,returnLocationId:id,supplierId:id.nullable(),reservationId:id.nullable(),lines:z.array(z.object({itemId:id,condition:z.enum(["USABLE","DAMAGED"]),quantity:laundryQuantitySchema}).strict()).min(1).max(50),reason:inventoryItemReasonSchema}).strict().superRefine((value,context)=>{if(new Set(value.lines.map(line=>line.itemId+":"+line.condition)).size!==value.lines.length)context.addIssue({code:"custom",path:["lines"],message:"Each original item and physical condition appears once"});if([value.sourceLocationId,value.returnLocationId,value.outboundTransitId,value.inboundTransitId].includes(value.laundryLocationId)||[value.outboundTransitId,value.inboundTransitId].some(transit=>transit===value.sourceLocationId||transit===value.returnLocationId))context.addIssue({code:"custom",message:"Original physical custody locations must remain distinct"});});
export const laundryBatchTransitionSchema=z.object({kind:z.enum(["SEND","RECEIVE_LAUNDRY","WASH_COMPLETE","REJECT","REWASH","DAMAGE","DISPATCH_RETURN","RECEIVE_RETURN","MARK_MISSING","FIND_MISSING","CONFIRM_LOSS"]),from:laundryBucketSchema,quantity:laundryQuantitySchema,reason:inventoryItemReasonSchema}).strict();
export type LaundryBatchTransition=z.infer<typeof laundryBatchTransitionSchema>;
export type LaundryLocationRole="origin"|"outbound"|"laundry"|"inbound"|"returned";
export type LaundryNativeMovement={kind:"LAUNDRY_SEND"|"LAUNDRY_RETURN"|"DAMAGE"|"LOSS";source:LaundryLocationRole;destination?:LaundryLocationRole;condition:"USABLE"|"DAMAGED"};
const damaged=(bucket:string)=>["OUTBOUND_DAMAGED","DAMAGED_READY","INBOUND_DAMAGED","RETURNED_DAMAGED"].includes(bucket.replace(/^MISSING_/u,""));
function location(bucket:string):LaundryLocationRole{const plain=bucket.replace(/^MISSING_/u,"");if(plain==="ORIGIN")return"origin";if(plain.startsWith("OUTBOUND"))return"outbound";if(plain.startsWith("INBOUND"))return"inbound";if(plain.startsWith("RETURNED"))return"returned";if(["LAUNDRY_PENDING","CLEAN_READY","REJECTED","DAMAGED_READY"].includes(plain))return"laundry";throw new InventoryCatalogDefinitionError();}
/** These are batch custody dispositions, never a replacement stock balance.
 * Every physical effect is delegated to the original movement writer. */
export function planLaundryBatchTransition(raw:unknown,initialCondition:"USABLE"|"DAMAGED",positions:ReadonlyMap<LaundryBucket,string>){
 const draft=laundryBatchTransitionSchema.parse(raw),quantity=BigInt(draft.quantity),from=draft.from;if(BigInt(stockQuantitySchema.parse(positions.get(from)??"0"))<quantity)throw new InventoryCatalogConflictError();let to:LaundryBucket, movement:LaundryNativeMovement|null=null;
 const requireFrom=(allowed:readonly LaundryBucket[])=>{if(!allowed.includes(from))throw new InventoryCatalogDefinitionError();};
 switch(draft.kind){
  case"SEND":requireFrom(["ORIGIN"]);to=initialCondition==="DAMAGED"?"OUTBOUND_DAMAGED":"OUTBOUND";movement={kind:"LAUNDRY_SEND",source:"origin",destination:"outbound",condition:initialCondition};break;
  case"RECEIVE_LAUNDRY":requireFrom(["OUTBOUND","OUTBOUND_DAMAGED"]);to=damaged(from)?"DAMAGED_READY":"LAUNDRY_PENDING";movement={kind:"LAUNDRY_SEND",source:"outbound",destination:"laundry",condition:damaged(from)?"DAMAGED":"USABLE"};break;
  case"WASH_COMPLETE":requireFrom(["LAUNDRY_PENDING"]);to="CLEAN_READY";break;
  case"REJECT":requireFrom(["LAUNDRY_PENDING"]);to="REJECTED";break;
  case"REWASH":requireFrom(["REJECTED"]);to="LAUNDRY_PENDING";break;
  case"DAMAGE":requireFrom(["OUTBOUND","LAUNDRY_PENDING","CLEAN_READY","REJECTED","INBOUND_CLEAN"]);to=from==="OUTBOUND"?"OUTBOUND_DAMAGED":from==="INBOUND_CLEAN"?"INBOUND_DAMAGED":"DAMAGED_READY";movement={kind:"DAMAGE",source:location(from),condition:"USABLE"};break;
  case"DISPATCH_RETURN":requireFrom(["CLEAN_READY","DAMAGED_READY"]);to=damaged(from)?"INBOUND_DAMAGED":"INBOUND_CLEAN";movement={kind:"LAUNDRY_RETURN",source:"laundry",destination:"inbound",condition:damaged(from)?"DAMAGED":"USABLE"};break;
  case"RECEIVE_RETURN":requireFrom(["INBOUND_CLEAN","INBOUND_DAMAGED"]);to=damaged(from)?"RETURNED_DAMAGED":"RETURNED_CLEAN";movement={kind:"LAUNDRY_RETURN",source:"inbound",destination:"returned",condition:damaged(from)?"DAMAGED":"USABLE"};break;
  case"MARK_MISSING":requireFrom(["OUTBOUND","OUTBOUND_DAMAGED","LAUNDRY_PENDING","CLEAN_READY","REJECTED","DAMAGED_READY","INBOUND_CLEAN","INBOUND_DAMAGED"]);to=laundryBucketSchema.parse("MISSING_"+from);break;
  case"FIND_MISSING":if(!from.startsWith("MISSING_"))throw new InventoryCatalogDefinitionError();to=laundryBucketSchema.parse(from.slice("MISSING_".length));break;
  case"CONFIRM_LOSS":if(!from.startsWith("MISSING_"))throw new InventoryCatalogDefinitionError();to=location(from)==="outbound"?"LOST_OUTBOUND":location(from)==="inbound"?"LOST_INBOUND":"LOST_LAUNDRY";movement={kind:"LOSS",source:location(from),condition:damaged(from)?"DAMAGED":"USABLE"};break;
 }
 const next=new Map(positions);next.set(from,(BigInt(next.get(from)??"0")-quantity).toString());next.set(to,(BigInt(next.get(to)??"0")+quantity).toString());return{draft,from,to,quantity:quantity.toString(),next,movement,requiresOverride:draft.kind==="CONFIRM_LOSS"};
}
export function laundryBatchLineComplete(positions:ReadonlyMap<LaundryBucket,string>){return[...positions].every(([bucket,quantity])=>BigInt(stockQuantitySchema.parse(quantity))===0n||["RETURNED_CLEAN","RETURNED_DAMAGED","LOST_OUTBOUND","LOST_LAUNDRY","LOST_INBOUND"].includes(bucket));}
