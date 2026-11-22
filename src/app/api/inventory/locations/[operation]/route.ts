import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {previewInventoryLocationChange,publishInventoryLocationChange,recoverInventoryLocationChange,getInventoryLocation,inventoryLocationPage,inventoryLocationPropertyChoices} from "@/modules/inventory/application/location-service";
export const runtime="nodejs";
const operations={review:previewInventoryLocationChange,publish:publishInventoryLocationChange,recover:recoverInventoryLocationChange,location:getInventoryLocation,page:inventoryLocationPage,properties:inventoryLocationPropertyChoices};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["review","publish","recover","location","page","properties"]).safeParse((await params).operation);
 return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-INV-02");
}
