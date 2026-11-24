import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {inventoryCountContext,previewInventoryCount,publishInventoryCount,recoverInventoryCount,inventoryCountPage} from "@/modules/inventory/application/stocktake-service";
export const runtime="nodejs";
const operations={context:inventoryCountContext,review:previewInventoryCount,publish:publishInventoryCount,recover:recoverInventoryCount,page:inventoryCountPage};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["context","review","publish","recover","page"]).safeParse((await params).operation);
 return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-INV-06");
}
