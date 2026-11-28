import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {previewInventoryMovement,publishInventoryMovement,recoverInventoryMovement,getInventoryMovement,inventoryMovementPage,inventoryMovementReservationChoices} from "@/modules/inventory/application/movement-service";
export const runtime="nodejs";
const operations={review:previewInventoryMovement,publish:publishInventoryMovement,recover:recoverInventoryMovement,movement:getInventoryMovement,page:inventoryMovementPage,reservations:inventoryMovementReservationChoices};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["review","publish","recover","movement","page","reservations"]).safeParse((await params).operation);
 return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-INV-03");
}
