import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryItemHttp} from "@/modules/inventory/ui/item-http";
import {previewInventoryItemChange,publishInventoryItemChange,recoverInventoryItemChange,getInventoryItem,inventoryItemPage} from "@/modules/inventory/application/item-service";
export const runtime="nodejs";
const operations={review:previewInventoryItemChange,publish:publishInventoryItemChange,recover:recoverInventoryItemChange,item:getInventoryItem,page:inventoryItemPage};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["review","publish","recover","item","page"]).safeParse((await params).operation);
 return inventoryItemHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});});
}
