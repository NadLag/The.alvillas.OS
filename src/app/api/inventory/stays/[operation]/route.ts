import type {NextRequest} from "next/server";
import {z} from "zod";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {inventoryStayConsumptionPage} from "@/modules/inventory/application/stay-consumption-service";
export const runtime="nodejs";
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){const operation=(await params).operation;return inventoryCatalogHttp(request,(actor,input)=>{if(operation!=="page")throw new z.ZodError([]);return inventoryStayConsumptionPage(actor,input);},"F-INV-08");}
