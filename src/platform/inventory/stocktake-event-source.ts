import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativeOrganizationTimezone} from "@/platform/config/organization-timezone";
import {stocktakeEventDataSchema} from "@/modules/inventory/domain/events";
import {inventoryCountDevice} from "@/modules/inventory/domain/stocktake-command";
import {InventoryRepository} from "@/modules/inventory/infrastructure/inventory-repository";
import {InventoryStocktakeRepository} from "@/modules/inventory/infrastructure/stocktake-repository";
import {inventoryMovementAuthorityInTransaction,inventoryMovementSourcesInTransaction,verifyInventoryMovementSourcesInTransaction} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
const payloadSchema=z.object({propertyId:z.uuid().optional(),inventory:z.object({item:z.string(),quantity:z.string()}).strict(),stocktake:stocktakeEventDataSchema,configuration:z.object({origin:z.literal("INVENTORY_WORKSPACE")}).strict()}).strict();
export async function nativeInventoryCountEventSource(tx:TenantTransaction,organizationId:string,event:{type:string;payload:unknown;idempotencyKey:string;occurredAt:Date}){
 if(event.type!=="StocktakeVariance")return null;const parsed=payloadSchema.safeParse(event.payload);if(!parsed.success)return null;const payload=parsed.data,row=await new InventoryStocktakeRepository(tx,organizationId).byId(payload.stocktake.id);if(!row||row.taskId||row.deviceId!==inventoryCountDevice(row.actorId)||!z.object({origin:z.literal("INVENTORY_WORKSPACE")}).safeParse(row.configSnapshot).success)throw new InventoryCatalogAccessError();
 const inventory=new InventoryRepository(tx,organizationId),[item,location]=await Promise.all([inventory.catalogItemById(row.itemId),inventory.locationCatalogById(row.locationId)]);if(!item||!location||(payload.propertyId??null)!==location.propertyId||row.propertyId!==location.propertyId||payload.inventory.item!==item.key||payload.inventory.quantity!==row.countedQuantity.toString()||event.idempotencyKey!==`inventory:${row.id}:variance`||event.occurredAt.toISOString()!==row.receivedAt.toISOString())throw new InventoryCatalogAccessError();
 const stocktake={id:row.id,expected:row.expectedQuantity.toFixed(0),actual:row.countedQuantity.toString(),delta:(row.countedQuantity-BigInt(row.expectedQuantity.toFixed(0))).toString(),revision:row.revision.toString()};if(stocktake.delta==="0"||jsonbFingerprint(stocktake)!==jsonbFingerprint(payload.stocktake))throw new InventoryCatalogAccessError();
 return{...stocktake,actorId:row.actorId,itemId:item.id,itemKey:item.key,locationId:location.id,propertyId:location.propertyId,timezone:await nativeOrganizationTimezone(tx,organizationId),witness:jsonbFingerprint({item,location,stocktake,actorId:row.actorId}),resources:[...["inventory_movement","inventory_item","inventory_location"].map(type=>({type,organizationId,dataClass:"operational"as const})),...location.propertyId?[{type:"property",organizationId,id:location.propertyId,propertyId:location.propertyId,city:location.propertyCity,region:location.propertyRegion,dataClass:"operational"as const}]:[]]};
}
export type NativeInventoryCountEventSource=NonNullable<Awaited<ReturnType<typeof nativeInventoryCountEventSource>>>;
export async function authorizeInventoryCountEventSource(actor:AccountActorContext,tx:TenantTransaction,value:NativeInventoryCountEventSource){
 const context=await inventoryMovementAuthorityInTransaction(actor,tx),source=await inventoryMovementSourcesInTransaction(actor,context,value.itemId,[value.locationId],[]),current=jsonbFingerprint({item:source.item,location:source.locations[0],stocktake:{id:value.id,expected:value.expected,actual:value.actual,delta:value.delta,revision:value.revision},actorId:value.actorId});if(current!==value.witness)throw new InventoryCatalogConflictError();await verifyInventoryMovementSourcesInTransaction(actor,tx,{...context,source,checks:[...context.checks,...source.checks]});return context;
}
