import {z} from "zod";
import {stockQuantitySchema,stockRevisionSchema} from "./stocktake";
import {inventoryItemReasonSchema} from "./item-catalog";
import {InventoryCatalogConflictError,InventoryCatalogDefinitionError} from "./catalog-errors";
const positiveQuantity=stockQuantitySchema.pipe(z.string().refine(value=>BigInt(value)>0n));
const common={itemId:z.uuid(),locationId:z.uuid(),quantity:positiveQuantity,reason:inventoryItemReasonSchema};
const condition=z.enum(["USABLE","DAMAGED"]).default("USABLE");
export const inventoryMovementKindSchema=z.enum(["PURCHASE","TRANSFER","CONSUMPTION","LAUNDRY_SEND","LAUNDRY_RETURN","DAMAGE","LOSS","DISPOSAL","ADJUSTMENT","RESERVATION","RELEASE"]);
export const inventoryMovementDraftSchema=z.discriminatedUnion("kind",[
 z.object({...common,kind:z.literal("PURCHASE")}).strict(),
 z.object({...common,kind:z.enum(["TRANSFER","LAUNDRY_SEND","LAUNDRY_RETURN"]),destinationLocationId:z.uuid(),condition}).strict(),
 z.object({...common,kind:z.literal("CONSUMPTION"),reservationId:z.uuid().optional()}).strict(),
 z.object({...common,kind:z.literal("DAMAGE")}).strict(),
 z.object({...common,kind:z.enum(["LOSS","DISPOSAL"]),condition}).strict(),
 z.object({...common,kind:z.literal("ADJUSTMENT"),direction:z.enum(["ADD","REMOVE"]),condition}).strict(),
 z.object({...common,kind:z.enum(["RESERVATION","RELEASE"]),reservationId:z.uuid()}).strict()
]);
export type InventoryMovementDraft=z.infer<typeof inventoryMovementDraftSchema>;
export const inventoryMovementPositionSchema=z.object({quantity:stockQuantitySchema,reserved:stockQuantitySchema,damaged:stockQuantitySchema,revision:stockRevisionSchema}).strict();
export type InventoryMovementPosition=z.infer<typeof inventoryMovementPositionSchema>;
export type InventoryMovementDelta={locationId:string;itemId:string;quantity:string;reserved:string;damaged:string;reservationId:string|null};
export class InventoryStockUnavailableError extends InventoryCatalogConflictError{}
export class InventoryReservationUnavailableError extends InventoryCatalogConflictError{}
export function inventoryStockAvailability(raw:InventoryMovementPosition){
 const value=inventoryMovementPositionSchema.parse(raw),physical=BigInt(value.quantity),reserved=BigInt(value.reserved),damaged=BigInt(value.damaged),available=physical-reserved-damaged;
 if(physical<0n||reserved<0n||damaged<0n)throw new InventoryCatalogDefinitionError();
 return{...value,available:available.toString(),shortage:(available<0n?-available:0n).toString(),conditionShortage:(damaged>physical?damaged-physical:0n).toString()};
}
export function applyInventoryMovementDelta(raw:InventoryMovementPosition,delta:Pick<InventoryMovementDelta,"quantity"|"reserved"|"damaged">){
 const before=inventoryStockAvailability(raw),quantity=BigInt(before.quantity)+BigInt(stockQuantitySchema.parse(delta.quantity)),reserved=BigInt(before.reserved)+BigInt(stockQuantitySchema.parse(delta.reserved)),damaged=BigInt(before.damaged)+BigInt(stockQuantitySchema.parse(delta.damaged));
 const originalConditionShortage=BigInt(before.conditionShortage);
 if(quantity<0n||reserved<0n||damaged<0n||damaged-quantity>originalConditionShortage)throw new InventoryStockUnavailableError();
 return inventoryStockAvailability(inventoryMovementPositionSchema.parse({quantity:quantity.toString(),reserved:reserved.toString(),damaged:damaged.toString(),revision:(BigInt(before.revision)+1n).toString()}));
}
type Location={id:string;kind:"PROPERTY"|"STORE"|"LAUNDRY"|"IN_TRANSIT";archived:boolean};
type Context={item:{id:string;category:"CONSUMABLE"|"LINEN"|"EQUIPMENT";archived:boolean};locations:readonly Location[];positions:ReadonlyMap<string,InventoryMovementPosition>;reservation?:{id:string;active:boolean;outstanding:string}};
/** Quantities use each original item's immutable counting unit. No implicit
 * conversion, valuation, prices or financial postings enter this ledger. */
export function planInventoryMovement(raw:unknown,context:Context){
 const draft=inventoryMovementDraftSchema.parse(raw),quantity=BigInt(draft.quantity);
 if(context.item.archived||context.item.id!==draft.itemId)throw new InventoryCatalogDefinitionError();
 const source=context.locations.find(value=>value.id===draft.locationId),position=context.positions.get(draft.locationId);if(!source||source.archived||!position)throw new InventoryCatalogDefinitionError();
 const before=inventoryStockAvailability(position),q=quantity.toString(),negative=(-quantity).toString(),zero="0",lines:InventoryMovementDelta[]=[];
 const delta=(locationId:string,physical=zero,reserved=zero,damaged=zero,reservationId:string|null=null)=>({locationId,itemId:draft.itemId,quantity:physical,reserved,damaged,reservationId});
 const available=()=>{if(BigInt(before.available)<quantity)throw new InventoryStockUnavailableError();};
 const conditionAvailable=(value:"USABLE"|"DAMAGED",commitment=true)=>{if(value==="DAMAGED"){if(BigInt(before.damaged)<quantity)throw new InventoryStockUnavailableError();}else if(commitment)available();else if(BigInt(before.quantity)-BigInt(before.damaged)<quantity)throw new InventoryStockUnavailableError();};
 const reservedSource=(active:boolean)=>{
  const reservation="reservationId"in draft?draft.reservationId:undefined;
  if(!reservation||context.reservation?.id!==reservation||active&&!context.reservation.active)throw new InventoryReservationUnavailableError();
  return BigInt(stockQuantitySchema.parse(context.reservation.outstanding));
 };
 switch(draft.kind){
  case"PURCHASE":lines.push(delta(source.id,q));break;
  case"TRANSFER":case"LAUNDRY_SEND":case"LAUNDRY_RETURN":{
   const target=context.locations.find(value=>value.id===draft.destinationLocationId);if(!target||target.archived||target.id===source.id||!context.positions.has(target.id))throw new InventoryCatalogDefinitionError();
   if(draft.kind!=="TRANSFER"&&context.item.category!=="LINEN")throw new InventoryCatalogDefinitionError();
   if(draft.kind==="LAUNDRY_SEND"&&(!["PROPERTY","STORE","IN_TRANSIT"].includes(source.kind)||!["LAUNDRY","IN_TRANSIT"].includes(target.kind)))throw new InventoryCatalogDefinitionError();
   if(draft.kind==="LAUNDRY_RETURN"&&(!["LAUNDRY","IN_TRANSIT"].includes(source.kind)||!["PROPERTY","STORE","IN_TRANSIT"].includes(target.kind)))throw new InventoryCatalogDefinitionError();
   conditionAvailable(draft.condition);lines.push(delta(source.id,negative,zero,draft.condition==="DAMAGED"?negative:zero),delta(target.id,q,zero,draft.condition==="DAMAGED"?q:zero));break;
  }
  case"CONSUMPTION":
   if(draft.reservationId){if(reservedSource(false)<quantity||BigInt(before.quantity)-BigInt(before.damaged)<quantity)throw new InventoryStockUnavailableError();lines.push(delta(source.id,negative,negative,zero,draft.reservationId));}
   else{available();lines.push(delta(source.id,negative));}break;
  case"DAMAGE":conditionAvailable("USABLE",false);lines.push(delta(source.id,zero,zero,q));break;
  case"LOSS":case"DISPOSAL":conditionAvailable(draft.condition,false);lines.push(delta(source.id,negative,zero,draft.condition==="DAMAGED"?negative:zero));break;
  case"ADJUSTMENT":{
   const adding=draft.direction==="ADD";if(!adding)conditionAvailable(draft.condition,false);lines.push(delta(source.id,adding?q:negative,zero,draft.condition==="DAMAGED"?(adding?q:negative):zero));break;
  }
  case"RESERVATION":reservedSource(true);available();lines.push(delta(source.id,zero,q,zero,draft.reservationId));break;
  case"RELEASE":if(reservedSource(false)<quantity)throw new InventoryReservationUnavailableError();lines.push(delta(source.id,zero,negative,zero,draft.reservationId));break;
 }
 const projected=lines.map(line=>({line,position:applyInventoryMovementDelta(context.positions.get(line.locationId)!,line)}));
 return{draft,lines,projected};
}
/** Reversal appends exact opposites. Commitments cannot be made less covered
 * by undoing an original purchase, transfer or release after subsequent use. */
export function planInventoryMovementReversal(lines:readonly InventoryMovementDelta[],positions:ReadonlyMap<string,InventoryMovementPosition>){
 if(lines.length<1||lines.length>2||new Set(lines.map(line=>line.locationId+":"+line.itemId)).size!==lines.length)throw new InventoryCatalogDefinitionError();
 return lines.map(original=>{const current=positions.get(original.locationId);if(!current)throw new InventoryCatalogDefinitionError();const before=inventoryStockAvailability(current),line={...original,quantity:(-BigInt(stockQuantitySchema.parse(original.quantity))).toString(),reserved:(-BigInt(stockQuantitySchema.parse(original.reserved))).toString(),damaged:(-BigInt(stockQuantitySchema.parse(original.damaged))).toString()},position=applyInventoryMovementDelta(current,line);
  if(BigInt(position.available)<(BigInt(before.available)<0n?BigInt(before.available):0n))throw new InventoryStockUnavailableError();return{line,position};
 });
}
