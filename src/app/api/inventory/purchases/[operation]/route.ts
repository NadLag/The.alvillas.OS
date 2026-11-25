import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {inventoryPurchaseContext,previewInventoryPurchase,publishInventoryPurchase,recoverInventoryPurchase} from "@/modules/inventory/application/purchase-service";
export const runtime="nodejs";
const operations={context:inventoryPurchaseContext,review:previewInventoryPurchase,publish:publishInventoryPurchase,recover:recoverInventoryPurchase};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=z.enum(["context","review","publish","recover"]).safeParse((await params).operation);return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-INV-07");}
