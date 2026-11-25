import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {inventoryProcurementList} from "@/modules/inventory/application/procurement-service";
export const runtime="nodejs";
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=(await params).operation;return inventoryCatalogHttp(request,(actor,input,requestId)=>{if(operation!=="page"&&operation!=="export")throw new z.ZodError([]);return inventoryProcurementList(actor,input,{exporting:operation==="export",requestId});},"F-INV-10");}
